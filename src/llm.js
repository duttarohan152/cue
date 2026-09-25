// LLM factory — OpenAI / Anthropic / Gemini / Amazon Bedrock behind one streaming interface.
// stream({ system, turns:[{role,text}], imageDataUrl, maxTokens, onToken }) -> Promise<fullText>

function normalizeProviderName(provider) {
  if (!provider) return 'provider';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function formatProviderErrorMessage(error, provider) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const code = error && (error.code || error.error?.code);
  const rawMessage = (error && (error.message || String(error))) || '';
  const text = `${rawMessage} ${status || ''} ${code || ''}`.toLowerCase();
  const isQuota = status === 429 || code === 'insufficient_quota' || code === 'rate_limit_exceeded' || /quota|billing|rate limit|exceeded your current quota/i.test(text);
  if (isQuota) {
    const label = normalizeProviderName(provider);
    return `${label} quota or rate-limit hit. Check your plan/billing for the API key, wait a moment, or switch to another provider in Settings.`;
  }
  return rawMessage || 'Unknown LLM error.';
}

function sanitizeTurns(turns) {
  const valid = new Set(['user', 'assistant']);
  return (turns || []).filter(t => valid.has(t.role)).map(t => ({ role: t.role, text: String(t.text || '') }));
}

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

async function streamOpenAI({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey });
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      messages.push({ role: 'user', content: [
        { type: 'text', text: t.text },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ] });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  const stream = await client.chat.completions.create({ model, messages, stream: true, max_tokens: maxTokens });
  let full = '';
  for await (const part of stream) {
    const d = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content;
    if (d) { full += d; onToken(d); }
  }
  return full;
}

// Anthropic message format is shared between the direct API and Amazon Bedrock.
function buildAnthropicMessages(turns, imageDataUrl) {
  return turns.map((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      const content = [];
      if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
      content.push({ type: 'text', text: t.text });
      return { role: 'user', content };
    }
    return { role: t.role, content: t.text };
  });
}

// The system prompt — guidance blocks plus the résumé/JD context — is identical
// from one request to the next within a session, so marking it as a cache
// breakpoint cuts time-to-first-token on every call after the first. Below the
// model's minimum (1024 tokens on Sonnet 5, 512 on Opus 5) the request still
// succeeds, it simply isn't cached, so there is nothing to guard against.
function buildAnthropicSystem(system, cacheTtl) {
  if (!system) return undefined;
  const cache_control = cacheTtl ? { type: 'ephemeral', ttl: cacheTtl } : { type: 'ephemeral' };
  return [{ type: 'text', text: system, cache_control }];
}

async function streamAnthropicClient(client, { model, system, turns, imageDataUrl, maxTokens, onToken, cacheTtl, effort }) {
  const messages = buildAnthropicMessages(turns, imageDataUrl);
  const body = { model, max_tokens: maxTokens, system: buildAnthropicSystem(system, cacheTtl), messages, stream: true };
  // Effort belongs at the TOP LEVEL in output_config. Putting it inside the
  // `thinking` object is a ValidationException. Omitting it entirely leaves the
  // API default of `high`, which is what every mode but debug wants.
  if (effort) body.output_config = { effort };
  const stream = await client.messages.create(body);
  let full = '';
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { full += ev.delta.text; onToken(ev.delta.text); }
  }
  return full;
}

// `effort` is deliberately not forwarded here. This provider's default models
// are Claude 3.5, which predate output_config and would reject it outright — a
// 400 on every debug call. Bedrock is where the Claude 5 models live.
async function streamAnthropic({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  return streamAnthropicClient(client, { model, system, turns, imageDataUrl, maxTokens, onToken });
}

async function streamBedrock({ awsAccessKey, awsSecretKey, awsRegion, awsSessionToken, model, system, turns, imageDataUrl, maxTokens, onToken, effort }) {
  const { AnthropicBedrock } = require('@anthropic-ai/bedrock-sdk');
  const client = new AnthropicBedrock({ awsAccessKey, awsSecretKey, awsRegion, awsSessionToken: awsSessionToken || undefined });
  // 1h TTL rather than the 5m default, because an interview runs far longer
  // than five minutes and the gaps between questions are easily that long.
  // Bedrock takes `ttl` natively; the direct Anthropic API needs a beta header
  // for it, so streamAnthropic deliberately leaves it at the default.
  return streamAnthropicClient(client, { model, system, turns, imageDataUrl, maxTokens, onToken, cacheTtl: '1h', effort });
}

async function streamGemini({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const contents = turns.map((t, i) => {
    const last = i === turns.length - 1;
    const parts = [{ text: t.text }];
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  const stream = await ai.models.generateContentStream({
    model, contents, config: { systemInstruction: system, maxOutputTokens: maxTokens }
  });
  let full = '';
  for await (const chunk of stream) {
    const t = chunk && chunk.text;
    if (t) { full += t; onToken(t); }
  }
  return full;
}

// Maximum output tokens each provider's configured models accept. Requesting
// more is a hard API error, so stream() clamps to these.
//
// Bedrock is 128000 because that is the real per-request ceiling for Sonnet 5
// and Opus 5. It matters more than it looks: both run adaptive thinking on by
// default at `high` effort, and max_tokens caps thinking AND answer text
// together — so a tight budget gets spent reasoning and truncates the answer
// mid-sentence rather than erroring. The others stay low because the default
// OpenAI/Anthropic/Gemini models here genuinely cap there.
const PROVIDER_MAX_OUTPUT = { openai: 16384, anthropic: 8192, gemini: 8192, bedrock: 128000 };

function createLLM(settings) {
  const provider = settings.provider;
  const keys = settings.apiKeys || {};
  const bedrockCreds = settings.bedrock || {};
  const isBedrock = provider === 'bedrock';
  const apiKey = keys[provider];
  const tier = settings.smart ? 'smart' : 'fast';
  let model = (settings.models[provider] || {})[tier];
  if (provider === 'gemini' && /^gemini-1\.5\-/.test(model || '')) {
    model = 'gemini-2.0-flash';
  }
  if (!model) {
    if (provider === 'gemini') model = 'gemini-2.0-flash';
    else if (provider === 'openai') model = 'gpt-4o-mini';
    else if (isBedrock) model = 'us.anthropic.claude-3-5-haiku-20241022-v1:0';
    else model = 'claude-3-5-haiku-latest';
  }
  const maxTokens = settings.smart ? 2800 : 1400;

  const bedrockReady = !!bedrockCreds.accessKeyId && !!bedrockCreds.secretAccessKey && !!bedrockCreds.region;

  return {
    provider, model, apiKey,
    ready: isBedrock ? (bedrockReady && !!model) : (!!apiKey && !!model),
    async stream(params) {
      const args = { apiKey, model, maxTokens, ...params, turns: sanitizeTurns(params.turns) };
      // Requesting more output tokens than a model allows is a hard API error,
      // so clamp the requested budget to each provider's real ceiling.
      args.maxTokens = Math.min(args.maxTokens, PROVIDER_MAX_OUTPUT[provider] || 8192);
      try {
        if (provider === 'openai') return await streamOpenAI(args);
        if (provider === 'anthropic') return await streamAnthropic(args);
        if (provider === 'gemini') return await streamGemini(args);
        if (provider === 'bedrock') return await streamBedrock({
          ...args,
          awsAccessKey: bedrockCreds.accessKeyId,
          awsSecretKey: bedrockCreds.secretAccessKey,
          awsRegion: bedrockCreds.region,
          awsSessionToken: bedrockCreds.sessionToken
        });
        throw new Error('unknown provider: ' + provider);
      } catch (error) {
        throw new Error(formatProviderErrorMessage(error, provider));
      }
    }
  };
}

module.exports = { createLLM, formatProviderErrorMessage };
