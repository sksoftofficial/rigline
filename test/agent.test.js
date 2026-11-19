import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent, MaxStepsError, JsonParseError } from '../src/Agent.js';
import {
    completion,
    textMessage,
    toolCallsMessage,
    toolCall,
    makeAgent,
    requestBody
} from './helpers.js';

const boomTool = {
    name: 'boom',
    description: 'Always fails.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => { throw new Error('kaput'); }
};

test('happy path: one tool call, then final answer', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [
        completion(toolCallsMessage([toolCall('call_1', 'read', { path: 'notes.txt' })])),
        completion(textMessage('The file says: hello world'))
    ], { systemPrompt: 'Be terse.' });
    await agent.workspace.put('notes.txt', 'hello world');

    const result = await agent.run('Read notes.txt and summarize it');

    assert.equal(result.text, 'The file says: hello world');
    assert.equal(result.steps, 2);
    assert.equal(result.messages.length, 5); // system, user, assistant(tool_calls), tool, assistant
    assert.deepEqual(result.usage, { promptTokens: 20, completionTokens: 10, totalTokens: 30 });
    assert.equal(fetchMock.mock.callCount(), 2);

    const first = requestBody(fetchMock, 0);
    assert.equal(first.model, 'test/model');
    assert.equal(first.stream, false);
    assert.deepEqual(first.messages.map((m) => m.role), ['system', 'user']);
    assert.equal(first.messages[0].content, 'Be terse.');
    assert.equal(first.tools[0].type, 'function');
    assert.equal(first.tools[0].function.name, 'read');

    const second = requestBody(fetchMock, 1);
    const toolMsg = second.messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg.tool_call_id, 'call_1');
    assert.equal(toolMsg.content, 'Read file notes.txt, lines 1-1\n1: hello world');
});

test('reasoning blocks on assistant messages are round-tripped to the next turn verbatim', async (t) => {
    const reasoningTurn = {
        role: 'assistant',
        content: null,
        reasoning: 'I should read the file first.',
        reasoning_details: [{ type: 'reasoning', text: 'I should read the file first.' }],
        tool_calls: [toolCall('call_1', 'read', { path: 'a.txt' })]
    };
    const { agent, fetchMock } = makeAgent(t, [
        completion(reasoningTurn),
        completion(textMessage('done'))
    ]);
    await agent.workspace.put('a.txt', 'AAA');

    await agent.run('read a.txt');

    const sentAssistant = requestBody(fetchMock, 1).messages.find((m) => m.role === 'assistant');
    assert.equal(sentAssistant.reasoning, 'I should read the file first.');
    assert.deepEqual(sentAssistant.reasoning_details, [{ type: 'reasoning', text: 'I should read the file first.' }]);
    assert.ok(Array.isArray(sentAssistant.tool_calls));
});

test('multiple tool calls in one turn all execute, in order, with matching ids', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [
        completion(toolCallsMessage([
            toolCall('call_a', 'read', { path: 'a.txt' }),
            toolCall('call_b', 'read', { path: 'b.txt' })
        ])),
        completion(textMessage('done'))
    ]);
    await agent.workspace.put('a.txt', 'AAA');
    await agent.workspace.put('b.txt', 'BBB');

    const result = await agent.run('read both files');

    const toolMsgs = requestBody(fetchMock, 1).messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 2);
    assert.deepEqual(toolMsgs.map((m) => m.tool_call_id), ['call_a', 'call_b']);
    assert.deepEqual(toolMsgs.map((m) => m.content), [
        'Read file a.txt, lines 1-1\n1: AAA',
        'Read file b.txt, lines 1-1\n1: BBB'
    ]);
    assert.equal(result.steps, 2);
});

test('a throwing tool does not abort the run: error goes back to the model', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [
        completion(toolCallsMessage([toolCall('c1', 'boom', {})])),
        completion(textMessage('recovered'))
    ], { tools: [boomTool] });

    const result = await agent.run('try the tool');

    const toolMsg = requestBody(fetchMock, 1).messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg.content, 'Error: kaput');
    assert.equal(result.text, 'recovered');
});

test('unknown tools and malformed arguments become recoverable tool errors', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [
        completion(toolCallsMessage([
            toolCall('c1', 'nope', {}),
            { id: 'c2', type: 'function', function: { name: 'read', arguments: '{broken json' } }
        ])),
        completion(textMessage('fine'))
    ]);

    const result = await agent.run('go');

    const msgs = requestBody(fetchMock, 1).messages.filter((m) => m.role === 'tool');
    assert.match(msgs[0].content, /Unknown tool 'nope'/);
    assert.match(msgs[1].content, /Invalid JSON arguments/);
    assert.equal(result.text, 'fine');
});

test('maxSteps exceeded throws MaxStepsError with the full transcript', async (t) => {
    const toolTurn = () => completion(toolCallsMessage([toolCall('c', 'boom', {})]));
    const { agent, fetchMock } = makeAgent(t, [toolTurn(), toolTurn()], { tools: [boomTool], maxSteps: 2 });

    await assert.rejects(agent.run('go'), (err) => {
        assert.ok(err instanceof MaxStepsError);
        assert.equal(err.name, 'MaxStepsError');
        assert.equal(err.maxSteps, 2);
        assert.equal(err.messages.length, 5); // user, assistant, tool, assistant, tool
        return true;
    });
    assert.equal(fetchMock.mock.callCount(), 2);
});

test('runJson returns the parsed final answer', async (t) => {
    const { agent } = makeAgent(t, [completion(textMessage('{"verdict":"yes","score":8}'))]);
    const decision = await agent.runJson('decide something');
    assert.deepEqual(decision, { verdict: 'yes', score: 8 });
});

test('runJson failure throws JsonParseError with raw text attached', async (t) => {
    const { agent } = makeAgent(t, [completion(textMessage('probably, sure'))]);

    await assert.rejects(agent.runJson('decide something'), (err) => {
        assert.ok(err instanceof JsonParseError);
        assert.equal(err.name, 'JsonParseError');
        assert.equal(err.raw, 'probably, sure');
        assert.equal(err.result.text, 'probably, sure');
        assert.equal(err.result.steps, 1);
        return true;
    });
});

test('runJson on empty final text also fails cleanly', async (t) => {
    const { agent } = makeAgent(t, [completion(textMessage(''))]);
    await assert.rejects(agent.runJson('decide'), JsonParseError);
});

test('conversation continues from a prior result.messages array, used verbatim', async (t) => {
    const { agent, fetchMock } = makeAgent(t, [
        completion(textMessage('first answer')),
        completion(textMessage('second answer'))
    ], { systemPrompt: 'sys' });

    const first = await agent.run('first question');
    const followUp = [...first.messages, { role: 'user', content: 'second question' }];
    const second = await agent.run(followUp);

    assert.equal(followUp.length, 4); // system, user, assistant, user — run() must not mutate the caller's array
    assert.equal(second.text, 'second answer');

    const roles = requestBody(fetchMock, 1).messages.map((m) => m.role);
    assert.deepEqual(roles, ['system', 'user', 'assistant', 'user']); // system not duplicated
});

test('onStep fires once per model turn with tool results and cumulative usage', async (t) => {
    const events = [];
    const { agent } = makeAgent(t, [
        completion(toolCallsMessage([toolCall('call_1', 'read', { path: 'notes.txt' })])),
        completion(textMessage('done'))
    ], {
        onStep: (event) => events.push(event)
    });
    await agent.workspace.put('notes.txt', 'hello');

    await agent.run('read it');

    assert.equal(events.length, 2);
    assert.equal(events[0].step, 1);
    assert.equal(events[0].message.tool_calls.length, 1);
    assert.equal(events[0].toolResults.length, 1);
    assert.equal(events[0].toolResults[0].name, 'read');
    assert.equal(events[0].toolResults[0].content, 'Read file notes.txt, lines 1-1\n1: hello');
    assert.equal(events[1].step, 2);
    assert.deepEqual(events[1].toolResults, []);
    assert.deepEqual(events[1].usage, { promptTokens: 20, completionTokens: 10, totalTokens: 30 });
});

test('run validates input', async (t) => {
    const { agent } = makeAgent(t, []);
    await assert.rejects(agent.run([]), /must not be empty/);
    await assert.rejects(agent.run(42), /prompt string or a messages array/);
});

test('usage.cost is passed through and summed when the provider returns it', async (t) => {
    const { agent } = makeAgent(t, [
        completion(toolCallsMessage([toolCall('c1', 'boom', {})]), { prompt_tokens: 100, completion_tokens: 50, cost: 0.01 }),
        completion(textMessage('ok'), { prompt_tokens: 10, completion_tokens: 5, cost: 0.02 })
    ], { tools: [boomTool] });

    const result = await agent.run('go');
    assert.deepEqual(result.usage, { promptTokens: 110, completionTokens: 55, totalTokens: 165, cost: 0.03 });
});

test('usage tracks reasoning and cached token details when reported, absent otherwise', async (t) => {
    const { agent } = makeAgent(t, [
        completion(toolCallsMessage([toolCall('c1', 'boom', {})]), {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
            prompt_tokens_details: { cached_tokens: 80 },
            completion_tokens_details: { reasoning_tokens: 40 },
            cost: 0.01
        }),
        // second step reports no details: totals keep deriving, detail sums stay
        completion(textMessage('ok'), { prompt_tokens: 10, completion_tokens: 5 })
    ], { tools: [boomTool] });

    const result = await agent.run('go');

    assert.deepEqual(result.usage, {
        promptTokens: 110,
        completionTokens: 55,
        totalTokens: 165, // 150 reported + 15 derived (10+5)
        reasoningTokens: 40,
        cachedTokens: 80,
        cost: 0.01
    });

    // a run where nothing reports details keeps the detail keys absent
    const plain = makeAgent(t, [completion(textMessage('ok'), { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 })]);
    assert.deepEqual((await plain.agent.run('go')).usage, {
        promptTokens: 7,
        completionTokens: 3,
        totalTokens: 10
    });
});
