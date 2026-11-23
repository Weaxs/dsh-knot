import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const app = agent({ name: 'acp-stdio-test-agent' });
app.onRequest(methods.agent.initialize, () => ({
  protocolVersion: PROTOCOL_VERSION,
  agentCapabilities: { loadSession: false },
}));
app.onRequest(methods.agent.session.new, () => ({ sessionId: 'stdio-session' }));
app.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
  const text = params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  const notify = (update) => client.notify(methods.client.session.update, { sessionId: params.sessionId, update });
  await notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Looking up a file' } });
  await notify({ sessionUpdate: 'tool_call', toolCallId: 'stdio-tool', title: 'Read file', name: 'read_file' });
  await notify({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'stdio-tool',
    rawInput: { path: 'README.md', password: 'pretend-password' },
  });
  await notify({ sessionUpdate: 'tool_call_update', toolCallId: 'stdio-tool', status: 'failed' });
  await notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `stdio:${text}` } });
  return { stopReason: 'end_turn' };
});
app.onNotification(methods.agent.session.cancel, () => {});
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
