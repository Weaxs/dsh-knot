import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

for (const name of ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL_NAME']) {
  if (!process.env[name])
    throw new Error(`${name} is required. Configure it as a GitHub Actions secret for real E2E tests.`);
}
if (!process.env.OPENCLAW_GATEWAY_TOKEN) {
  throw new Error('OPENCLAW_GATEWAY_TOKEN must contain an ephemeral gateway token for the E2E environment');
}

const modelId = process.env.OPENAI_MODEL_NAME.replace(/^openai\//, '');
const modelRef = `openai/${modelId}`;
const containerBaseUrl = process.env.OPENAI_BASE_URL.replace(
  /^(https?:\/\/)(?:127\.0\.0\.1|localhost)(?=[:/]|$)/,
  '$1host.docker.internal',
);
const output = process.env.E2E_CONFIG_OUTPUT ?? resolve('.github/e2e/generated/openclaw.json');
const hermesOutput = process.env.E2E_HERMES_CONFIG_OUTPUT ?? resolve('.github/e2e/generated/hermes-config.yaml');
const dshPatchOutput = process.env.E2E_DSH_PATCH_OUTPUT ?? resolve('.github/e2e/generated/dsh/patch.yml');
const config = {
  gateway: {
    mode: 'local',
    port: 18789,
    bind: 'lan',
    auth: { mode: 'token', token: process.env.OPENCLAW_GATEWAY_TOKEN },
    controlUi: { enabled: false, allowedOrigins: ['http://127.0.0.1:18789'] },
    http: { endpoints: { chatCompletions: { enabled: true } } },
    nodes: { pairing: { autoApproveLocal: true } },
  },
  models: {
    mode: 'merge',
    providers: {
      openai: {
        api: 'openai-completions',
        apiKey: { source: 'env', provider: 'default', id: 'OPENAI_API_KEY' },
        baseUrl: containerBaseUrl,
        agentRuntime: { id: 'pi' },
        timeoutSeconds: 180,
        models: [
          {
            id: modelId,
            name: modelId,
            api: 'openai-completions',
            reasoning: true,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            contextTokens: 64000,
            maxTokens: 512,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: modelRef, fallbacks: [] },
      models: { [modelRef]: { agentRuntime: { id: 'pi' }, params: { transport: 'sse', openaiWsWarmup: false } } },
      workspace: '/tmp/openclaw-e2e-workspace',
      skipBootstrap: true,
      thinkingDefault: 'low',
      timeoutSeconds: 180,
    },
  },
  plugins: { enabled: true, allow: ['openai'], entries: { openai: { enabled: true } } },
  skills: { allowBundled: [] },
  tools: { allow: [] },
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
chmodSync(output, 0o644);
const hermesConfig = [
  'model:',
  `  default: ${JSON.stringify(modelId)}`,
  '  provider: custom',
  `  base_url: ${JSON.stringify(containerBaseUrl)}`,
  '  key_env: OPENAI_API_KEY',
  'agent:',
  '  reasoning_effort: low',
  '',
].join('\n');
writeFileSync(hermesOutput, hermesConfig, { mode: 0o644 });
chmodSync(hermesOutput, 0o644);
const dshPatch = [
  '- id: llm-pi-ai',
  "  name: '@deepseek-ai/dsh-llm-pi-ai'",
  '  config:',
  '    providers:',
  '      openai:',
  '        apiKeyEnv: OPENAI_API_KEY',
  '        api: openai-completions',
  '        compat:',
  '          supportsDeveloperRole: false',
  `        baseURL: ${JSON.stringify(containerBaseUrl)}`,
  '        models:',
  `          - id: ${JSON.stringify(modelId)}`,
  `            name: ${JSON.stringify(modelId)}`,
  '            contextWindow: 128000',
  '            reasoningEfforts:',
  '              low: low',
  '              high: high',
  '              max: max',
  '',
].join('\n');
mkdirSync(dirname(dshPatchOutput), { recursive: true });
writeFileSync(dshPatchOutput, dshPatch, { mode: 0o644 });
chmodSync(dshPatchOutput, 0o644);
if (process.env.GITHUB_ENV) {
  appendFileSync(process.env.GITHUB_ENV, `E2E_CONTAINER_OPENAI_BASE_URL=${containerBaseUrl}\n`);
}
console.log(`Wrote OpenClaw E2E config for ${modelRef}; credentials are not printed.`);
