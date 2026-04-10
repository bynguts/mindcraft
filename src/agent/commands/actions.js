import * as skills from '../library/skills.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import fs from 'fs';
import { makeCompartment } from '../library/lockdown.js';
import * as worldLib from '../library/world.js';
import { Vec3 } from 'vec3';
import { addCommand } from './index.js';
import path from 'path';

function runAsAction(actionFn, resume = false, timeout = -1) {
    let actionLabel = null;

    const wrappedAction = async function (agent, ...args) {
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1);
        }

        const actionFnWithAgent = async () => {
            await actionFn(agent, ...args);
        };
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout, resume });
        if (code_return.interrupted && !code_return.timedout)
            return;
        return code_return.message;
    }

    return wrappedAction;
}

export const actionsList = [
    {
        name: '!newAction',
        description: 'Perform custom behaviors not available as a command.',
        params: {
            'prompt': { type: 'string', description: 'A natural language prompt to guide code generation. Make a detailed step-by-step plan.' },
            // FIXED: Tambahkan parameter dependencies agar LLM bisa mendefinisikannya (Bug #36)
            'dependencies': { type: 'string', description: 'Optional comma-separated list of items/skills required to execute this action (e.g. "oak_log, crafting_table"). Leave empty if none.' }
        },
        perform: async function (agent, prompt, dependencies = "") {
            if (!settings.allow_insecure_coding) {
                agent.openChat('newAction is disabled.');
                return "newAction not allowed! Code writing is disabled.";
            }
            let result = "";
            const actionFn = async () => {
                try {
                    let prevCounter = agent.coder.file_counter;
                    result = await agent.coder.generateCode(agent.history);

                    if (agent.coder.file_counter > prevCounter && !result.includes('Code generation failed')) {
                        let cleanName = prompt.split(' ').slice(0, 4).join('_').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
                        if (!cleanName || cleanName === '') cleanName = 'custom_action_' + Date.now();

                        let lastFile = `.${agent.coder.fp}${prevCounter}.js`;
                        let saveFolder = './bots/saved_skills/';

                        if (!fs.existsSync(saveFolder)) fs.mkdirSync(saveFolder, { recursive: true });

                        const historyFolder = path.join(saveFolder, 'history');
                        const targetFile = path.join(saveFolder, `${cleanName}.js`);

                        if (fs.existsSync(targetFile)) {
                            if (!fs.existsSync(historyFolder)) fs.mkdirSync(historyFolder, { recursive: true });

                            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                            const backupPath = path.join(historyFolder, `${cleanName}_${timestamp}.js.bak`);

                            fs.renameSync(targetFile, backupPath);
                            console.log(`[Versioning] Backed up old version of ${cleanName} to history.`);
                        }

                        fs.copyFileSync(lastFile, targetFile);

                        // FIXED: Parse dependencies dan daftarkan ke metadata (Bug #36)
                        let depsArray = typeof dependencies === 'string' && dependencies.trim() !== '' ? dependencies.split(',').map(d => d.trim()) : [];

                        if (agent.learned_skills) {
                            agent.learned_skills.registerSkill(cleanName, prompt, ["auto-generated", "action"], depsArray);
                        }
                        const newCommand = {
                            name: `!${cleanName}`,
                            description: `Automatic skill: ${cleanName.replace(/_/g, ' ')}. Use this !${cleanName} command if the user asks you to perform a similar action or one with the same meaning.`,
                            perform: runAsAction(async (agent) => {
                                const src = fs.readFileSync(`${saveFolder}${cleanName}.js`, 'utf8');
                                const compartment = makeCompartment({
                                    skills: skills,
                                    log: skills.log,
                                    world: worldLib,
                                    Vec3
                                });

                                try {
                                    const mainFn = compartment.evaluate(src);
                                    await mainFn(agent.bot);

                                    // SUCCESS TRACKING: Report successful execution
                                    if (agent.learned_skills) {
                                        agent.learned_skills.updateSkillPerformance(cleanName, true);
                                    }
                                } catch (err) {
                                    console.error(`Skill ${cleanName} execution failed:`, err);

                                    // FAILURE TRACKING: Report failed execution
                                    if (agent.learned_skills) {
                                        agent.learned_skills.updateSkillPerformance(cleanName, false);
                                    }
                                    throw err;
                                }
                            })
                        };

                        actionsList.push(newCommand);
                        addCommand(newCommand);

                        result += `\n[SUCCESS: Skill !${cleanName} has been learned and is ready to use.]`;
                    }
                } catch (e) {
                    result = 'Error generating code: ' + e.toString();
                }
            };
            await agent.actions.runAction('action:newAction', actionFn, { timeout: settings.code_timeout_mins });
            return result;
        }
    },
    {
        name: '!stop',
        description: 'Force stop all executing actions.',
        perform: async function (agent) {
            await agent.actions.stop();
            agent.clearBotLogs();
            agent.actions.cancelResume();
            agent.bot.emit('idle');
            let msg = 'Agent stopped.';
            if (agent.self_prompter.isActive())
                msg += ' Self-prompting still active.';
            return msg;
        }
    },
    {
        name: '!stfu',
        description: 'Stop chatting and self-prompting, but continue current action.',
        perform: async function (agent) {
            agent.openChat('Shutting up.');
            agent.shutUp();
            return;
        }
    },
    {
        name: '!restart',
        description: 'Restart the agent process.',
        perform: async function (agent) {
            agent.cleanKill();
        }
    },
    {
        name: '!clearChat',
        description: 'Clear the chat history.',
        perform: async function (agent) {
            agent.history.clear();
            return agent.name + "'s chat history was cleared, starting new conversation from scratch.";
        }
    },
    {
        name: '!goToPlayer',
        description: 'Go to the given player.',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to go to.' },
            'closeness': { type: 'float', description: 'How close to get to the player.', domain: [0, Infinity] }
        },
        perform: runAsAction(async (agent, player_name, closeness) => {
            await skills.goToPlayer(agent.bot, player_name, closeness);
        })
    },
    {
        name: '!followPlayer',
        description: 'Endlessly follow the given player.',
        params: {
            'player_name': { type: 'string', description: 'name of the player to follow.' },
            'follow_dist': { type: 'float', description: 'The distance to follow from.', domain: [0, Infinity] }
        },
        perform: runAsAction(async (agent, player_name, follow_dist) => {
            await skills.followPlayer(agent.bot, player_name, follow_dist);
        }, true)
    },
    {
        name: '!goToCoordinates',
        description: 'Go to the given x, y, z location.',
        params: {
            'x': { type: 'float', description: 'The x coordinate.', domain: [-Infinity, Infinity] },
            'y': { type: 'float', description: 'The y coordinate.', domain: [-64, 320] },
            'z': { type: 'float', description: 'The z coordinate.', domain: [-Infinity, Infinity] },
            'closeness': { type: 'float', description: 'How close to get to the location.', domain: [0, Infinity] }
        },
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            await skills.goToPosition(agent.bot, x, y, z, closeness);
        })
    },
    {
        name: '!searchForBlock',
        description: 'Find and go to nearest block of given type.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the block. Minimum 32.', domain: [10, 512] }
        },
        perform: runAsAction(async (agent, block_type, range) => {
            if (range < 32) {
                skills.log(agent.bot, `Minimum search range is 32.`);
                range = 32;
            }
            await skills.goToNearestBlock(agent.bot, block_type, 4, range);
        })
    },
    {
        name: '!searchForEntity',
        description: 'Find and go to nearest entity within range.',
        params: {
            'type': { type: 'string', description: 'The type of entity to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the entity.', domain: [32, 512] }
        },
        perform: runAsAction(async (agent, entity_type, range) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: 'Move away in any direction by a given distance.',
        params: { 'distance': { type: 'float', description: 'The distance to move away.', domain: [0, Infinity] } },
        perform: runAsAction(async (agent, distance) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!rememberHere',
        description: 'Save the current location with a given name.',
        params: { 'name': { type: 'string', description: 'The name to remember the location as.' } },
        perform: async function (agent, name) {
            const pos = agent.bot.entity.position;
            agent.memory_bank.rememberPlace(name, pos.x, pos.y, pos.z);
            return `Location saved as "${name}".`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: 'Go to a saved location.',
        params: { 'name': { type: 'string', description: 'The name of the location to go to.' } },
        perform: runAsAction(async (agent, name) => {
            const pos = agent.memory_bank.recallPlace(name);
            if (!pos) {
                skills.log(agent.bot, `No location named "${name}" saved.`);
                return;
            }
            await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2], 1);
        })
    },
    {
        name: '!givePlayer',
        description: 'Give item to player.',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to give the item to.' },
            'item_name': { type: 'ItemName', description: 'The name of the item to give.' },
            'num': { type: 'int', description: 'The number of items to give.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            await skills.giveToPlayer(agent.bot, item_name, player_name, num);
        })
    },
    {
        name: '!consume',
        description: 'Eat/drink the given item.',
        params: { 'item_name': { type: 'ItemName', description: 'The name of the item to consume.' } },
        perform: runAsAction(async (agent, item_name) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: 'Equip the given item.',
        params: { 'item_name': { type: 'ItemName', description: 'The name of the item to equip.' } },
        perform: runAsAction(async (agent, item_name) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!putInChest',
        description: 'Put items into nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to put in the chest.' },
            'num': { type: 'int', description: 'The number of items to put in the chest.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.putInChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!takeFromChest',
        description: 'Take items from nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to take.' },
            'num': { type: 'int', description: 'The number of items to take.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.takeFromChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!viewChest',
        description: 'View contents of nearest chest.',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.viewChest(agent.bot);
        })
    },
    {
        name: '!discard',
        description: 'Discard the given item from the inventory.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to discard.' },
            'num': { type: 'int', description: 'The number of items to discard.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            const start_loc = agent.bot.entity.position;
            await skills.moveAway(agent.bot, 5);
            await skills.discard(agent.bot, item_name, num);
            await skills.goToPosition(agent.bot, start_loc.x, start_loc.y, start_loc.z, 0);
        })
    },
    {
        name: '!collectBlocks',
        description: 'Collect nearby blocks of given type.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to collect.' },
            'num': { type: 'int', description: 'The number of blocks to collect.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, type, num) => {
            await skills.collectBlock(agent.bot, type, num);
        }, false, 10)
    },
    {
        name: '!craftRecipe',
        description: 'Craft the given recipe a given number of times.',
        params: {
            'recipe_name': { type: 'ItemName', description: 'The name of the output item to craft.' },
            'num': { type: 'int', description: 'The number of times to craft the recipe. This is NOT the number of output items, as it may craft many more items depending on the recipe.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, recipe_name, num) => {
            await skills.craftRecipe(agent.bot, recipe_name, num);
        })
    },
    {
        name: '!smeltItem',
        description: 'Smelt item a given number of times.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the input item to smelt.' },
            'num': { type: 'int', description: 'The number of times to smelt the item.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            let success = await skills.smeltItem(agent.bot, item_name, num);
            // FIXED: Removed agent.cleanKill() to prevent infinite loop on load_memory: true
            if (success) {
                skills.log(agent.bot, 'Smelting complete. Inventory will update naturally.');
            }
        })
    },
    {
        name: '!clearFurnace',
        description: 'Empty all items from nearest furnace.',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
    {
        name: '!placeHere',
        description: 'Place single block at current location. Do NOT use to build structures.',
        params: { 'type': { type: 'BlockOrItemName', description: 'The block type to place.' } },
        perform: runAsAction(async (agent, type) => {
            let pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        name: '!attack',
        description: 'Attack and kill nearest entity of given type.',
        params: { 'type': { type: 'string', description: 'The type of entity to attack.' } },
        perform: runAsAction(async (agent, type) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!attackPlayer',
        description: 'Attack a player until they die or run away.',
        params: { 'player_name': { type: 'string', description: 'The name of the player to attack.' } },
        perform: runAsAction(async (agent, player_name) => {
            let player = agent.bot.players[player_name]?.entity;
            if (!player) {
                skills.log(agent.bot, `Could not find player ${player_name}.`);
                return false;
            }
            await skills.attackEntity(agent.bot, player, true);
        })
    },
    {
        name: '!goToBed',
        description: 'Go to the nearest bed and sleep.',
        perform: runAsAction(async (agent) => {
            await skills.goToBed(agent.bot);
        })
    },
    {
        name: '!stay',
        description: 'Stay in current location. Pauses all modes.',
        params: { 'type': { type: 'int', description: 'The number of seconds to stay. -1 for forever.', domain: [-1, Number.MAX_SAFE_INTEGER] } },
        perform: runAsAction(async (agent, seconds) => {
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!setMode',
        description: 'Toggle an automatic behavior mode on or off.',
        params: {
            'mode_name': { type: 'string', description: 'The name of the mode to enable.' },
            'on': { type: 'boolean', description: 'Whether to enable or disable the mode.' }
        },
        perform: async function (agent, mode_name, on) {
            const modes = agent.bot.modes;
            if (!modes.exists(mode_name))
                return `Mode ${mode_name} does not exist.` + modes.getDocs();
            if (modes.isOn(mode_name) === on)
                return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`;
            modes.setOn(mode_name, on);
            return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`;
        }
    },
    {
        name: '!goal',
        description: 'Set an endless goal with continuous self-prompting.',
        params: {
            'selfPrompt': { type: 'string', description: 'The goal prompt.' },
        },
        perform: async function (agent, prompt) {
            if (convoManager.inConversation()) {
                agent.self_prompter.setPromptPaused(prompt);
            }
            else {
                agent.self_prompter.start(prompt);
            }
        }
    },
    {
        name: '!endGoal',
        description: 'Stop self-prompting and current action.',
        perform: async function (agent) {
            agent.self_prompter.stop();
            return 'Self-prompting stopped.';
        }
    },
    {
        name: '!showVillagerTrades',
        description: 'Show trades of a specified villager.',
        params: { 'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' } },
        perform: runAsAction(async (agent, id) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: 'Trade with a specified villager.',
        params: {
            'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' },
            'index': { type: 'int', description: 'The index of the trade you want executed (1-indexed).', domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: 'How many times that trade should be executed.', domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!startConversation',
        description: 'Start a conversation with a bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to send the message to.' },
            'message': { type: 'string', description: 'The message to send.' },
        },
        perform: async function (agent, player_name, message) {
            if (!convoManager.isOtherAgent(player_name))
                return player_name + ' is not a bot, cannot start conversation.';
            if (convoManager.inConversation() && !convoManager.inConversation(player_name))
                convoManager.forceEndCurrentConversation();
            else if (convoManager.inConversation(player_name))
                agent.history.add('system', 'You are already in conversation with ' + player_name + '. Don\'t use this command to talk to them.');
            convoManager.startConversation(player_name, message);
        }
    },
    {
        name: '!endConversation',
        description: 'End the conversation with the given bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to end the conversation with.' }
        },
        perform: async function (agent, player_name) {
            if (!convoManager.inConversation(player_name))
                return `Not in conversation with ${player_name}.`;
            convoManager.endConversation(player_name);
            return `Converstaion with ${player_name} ended.`;
        }
    },
    {
        name: '!lookAtPlayer',
        description: 'Look at a player or look in the same direction as the player.',
        params: {
            'player_name': { type: 'string', description: 'Name of the target player' },
            'direction': {
                type: 'string',
                description: 'How to look ("at": look at the player, "with": look in the same direction as the player)',
            }
        },
        perform: async function (agent, player_name, direction) {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPlayer(player_name, direction);
            };
            await agent.actions.runAction('action:lookAtPlayer', actionFn);
            return result;
        }
    },
    {
        name: '!lookAtPosition',
        description: 'Look at specified coordinates.',
        params: {
            'x': { type: 'int', description: 'x coordinate' },
            'y': { type: 'int', description: 'y coordinate' },
            'z': { type: 'int', description: 'z coordinate' }
        },
        perform: async function (agent, x, y, z) {
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPosition(x, y, z);
            };
            await agent.actions.runAction('action:lookAtPosition', actionFn);
            return result;
        }
    },
    {
        name: '!digDown',
        description: 'Dig down safely until stopping at water/lava or dropoff.',
        params: { 'distance': { type: 'int', description: 'Distance to dig down', domain: [1, Number.MAX_SAFE_INTEGER] } },
        perform: runAsAction(async (agent, distance) => {
            await skills.digDown(agent.bot, distance)
        })
    },
    {
        name: '!goToSurface',
        description: 'Moves the bot to the highest block above it (usually the surface).',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        name: '!useOn',
        description: 'Use (right click) the given tool on the nearest target of the given type.',
        params: {
            'tool_name': { type: 'string', description: 'Name of the tool to use, or "hand" for no tool.' },
            'target': { type: 'string', description: 'The target as an entity type, block type, or "nothing" for no target.' }
        },
        perform: runAsAction(async (agent, tool_name, target) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
    {
        name: '!exploreUntilFound',
        description: 'Explore randomly to find target outside radar.',
        params: {
            'target_name': { type: 'string', description: 'The name of the target to find (e.g., "iron_ore", "villager", "cow").' },
            'type': { type: 'string', description: 'The type of target: "block" or "entity".' },
            'max_attempts': { type: 'int', description: 'Max attempts to move and scan before giving up.', domain: [1, 50] }
        },
        perform: runAsAction(async (agent, target_name, type, max_attempts) => {
            await skills.exploreUntilFound(agent.bot, target_name, type, max_attempts);
        })
    },
    {
        name: '!forceWalkTowards',
        description: 'Walk blindly towards target for a few seconds. Use ONLY if stuck.',
        params: {
            'target_name': { type: 'string', description: 'The name or username to walk towards.' },
            'duration': { type: 'int', description: 'How many seconds to hold the forward and jump keys.' }
        },
        perform: runAsAction(async (agent, target_name, duration) => {
            await skills.forceWalkTowards(agent.bot, target_name, duration);
        })
    },
    {
        name: '!rightClickBlock',
        description: 'Generic right-click on block (for flint, shovel paths, levers, beds, etc).',
        params: {
            'x': { type: 'int', description: 'X coordinate' },
            'y': { type: 'int', description: 'Y coordinate' },
            'z': { type: 'int', description: 'Z coordinate' }
        },
        perform: runAsAction(async (agent, x, y, z) => {
            await skills.rightClickBlock(agent.bot, x, y, z);
        })
    },
    {
        name: '!mountEntity',
        description: 'Mount the nearest entity of a specific type (e.g., horse, pig, boat, camel, minecart).',
        params: {
            'entity_name': { type: 'string', description: 'The name of the entity to mount (e.g., "horse", "boat").' }
        },
        perform: runAsAction(async (agent, entity_name) => {
            await skills.mountEntity(agent.bot, entity_name);
        })
    },
    {
        name: '!dismount',
        description: 'Dismount or get off from the current vehicle or animal you are riding.',
        params: {
            'vehicle_name': { type: 'string', description: 'The name of the vehicle/animal you are dismounting, e.g., "horse"' }
        },
        perform: runAsAction(async (agent, vehicle_name) => {
            await skills.dismount(agent.bot);
        })
    },
    {
        name: '!unequip',
        description: 'Unequip armor or items (e.g., "head", "hand", "torso").',
        params: {
            'destination': { type: 'string', description: 'The body part (e.g., "torso" for chestplate, "head" for helmet).' }
        },
        perform: runAsAction(async (agent, destination) => {
            return await skills.unequipArmor(agent.bot, destination);
        })
    },
    {
        name: '!saddleEntity',
        description: 'Equip a saddle from your inventory and put it on the nearest tamed animal of the specified type.',
        params: {
            'entity_name': { type: 'string', description: 'The type of animal to saddle, like "horse" or "pig"' }
        },
        perform: runAsAction(async (agent, entity_name) => {
            await skills.saddleEntity(agent.bot, entity_name);
        })
    },
];

// FIXED: Encapsulated auto-load logic to prevent module-scope blocking and crashes.
let skillsLoaded = false;

export function loadSavedSkills() {
    const saveFolder = './bots/saved_skills/';
    const metadataPath = `${saveFolder}metadata.json`;
    let validSkills = {};

    if (fs.existsSync(metadataPath)) {
        try {
            validSkills = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        } catch (e) {
            console.warn('[Auto-Skill] Could not read metadata.json, starting fresh.');
        }
    }

    if (fs.existsSync(saveFolder)) {
        const files = fs.readdirSync(saveFolder);
        for (const file of files) {
            if (file.endsWith('.js')) {
                const commandName = file.replace('.js', '');

                if (!validSkills[commandName]) {
                    console.log(`[Auto-Skill] Deleting orphaned/outdated zombie skill: ${file}`);
                    fs.unlinkSync(`${saveFolder}${file}`);
                    continue;
                }

                const existingIndex = actionsList.findIndex(a => a.name === `!${commandName}`);
                if (existingIndex !== -1) {
                    actionsList.splice(existingIndex, 1);
                }

                // FIXED: Suntikkan dependencies ke dalam description command agar agen tahu syaratnya (Bug #36)
                const deps = validSkills[commandName].dependencies;
                const depsText = deps && deps.length > 0 ? ` [Requires: ${deps.join(', ')}]` : '';

                const newCommand = {
                    name: `!${commandName}`,
                    description: (validSkills[commandName].description || `Automatic skill: ${commandName.replace(/_/g, ' ')}. Use this !${commandName} command if the user asks you to perform a similar action or one with the same meaning based on the name.`) + depsText,
                    perform: runAsAction(async (agent) => {
                        const src = fs.readFileSync(`${saveFolder}${file}`, 'utf8');
                        const compartment = makeCompartment({
                            skills: skills,
                            log: skills.log,
                            world: worldLib,
                            Vec3
                        });

                        try {
                            const mainFn = compartment.evaluate(src);
                            await mainFn(agent.bot);

                            if (agent.learned_skills) {
                                agent.learned_skills.updateSkillPerformance(commandName, true);
                            }
                        } catch (err) {
                            console.error(`[Auto-Skill] ${commandName} execution failed:`, err);

                            if (agent.learned_skills) {
                                agent.learned_skills.updateSkillPerformance(commandName, false);
                            }
                            throw err;
                        }
                    })
                };

                actionsList.push(newCommand);
                addCommand(newCommand);
                console.log(`[Auto-Load] Valid skill loaded/reloaded: !${commandName}`);
            }
        }
    }
}