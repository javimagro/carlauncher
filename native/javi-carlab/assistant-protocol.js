'use strict';

const { providers } = require('./assistant-config');
const { tools, instructions } = require('./assistant-tools');
function connection(config) {
    if (config.provider === 'openai') return { url: 'wss://api.openai.com/v1/realtime?model=' + providers.openai.model,
        headers: { Authorization: 'Bearer ' + config.key } };
    return { url: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=' + encodeURIComponent(config.key), headers: {} };
}
function setup(config) {
    if (config.provider === 'openai') return { type: 'session.update', session: {
        type: 'realtime', model: providers.openai.model, instructions, tools, tool_choice: 'auto',
        output_modalities: [config.audio ? 'audio' : 'text'],
        audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, turn_detection: null },
            output: { format: { type: 'audio/pcm', rate: 24000 }, voice: config.voice } }
    } };
    return { setup: { model: 'models/' + providers.gemini.model,
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } } } },
        systemInstruction: { parts: [{ text: instructions }] }, outputAudioTranscription: {}, inputAudioTranscription: {},
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
        tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description,
            parameters: { type: 'object', properties: t.parameters.properties, required: t.parameters.required } })) }] } };
}
function textInput(provider, text) {
    return provider === 'openai' ? [{ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }, { type: 'response.create' }] :
        [{ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } }];
}
function toolResult(provider, id, name, result) {
    return provider === 'openai' ? [{ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: id, output: JSON.stringify(result) } }] :
        [{ toolResponse: { functionResponses: [{ id, name, response: result }] } }];
}
function events(provider, message) {
    const out = [];
    if (message.error) return [{ type: 'error', code: 'PROVIDER_ERROR' }];
    if (provider === 'openai') {
        if (message.type === 'session.updated') out.push({ type: 'ready' });
        if (['response.output_text.delta', 'response.output_audio_transcript.delta'].includes(message.type)) out.push({ type: 'text', text: message.delta });
        if (message.type === 'response.output_audio.delta') out.push({ type: 'audio', data: message.delta, rate: 24000 });
        if (message.type === 'response.function_call_arguments.done') {
            let args; try { args = JSON.parse(message.arguments); } catch (_) { args = null; }
            out.push({ type: 'tool', id: message.call_id, name: message.name, args });
        }
        if (message.type === 'response.done') out.push({ type: message.response && message.response.status === 'failed' ? 'error' : 'turn', code: 'RESPONSE_FAILED' });
    } else {
        if (message.setupComplete || message.setup_complete) out.push({ type: 'ready' });
        const content = message.serverContent || {};
        if (content.interrupted) out.push({ type: 'interrupt' });
        if (content.outputTranscription && content.outputTranscription.text) out.push({ type: 'text', text: content.outputTranscription.text });
        if (content.inputTranscription && content.inputTranscription.text) out.push({ type: 'input', text: content.inputTranscription.text });
        const parts = content.modelTurn && content.modelTurn.parts || [];
        parts.slice(0, 32).forEach((p) => {
            if (p.inlineData && /^audio\/pcm(;rate=24000)?$/.test(p.inlineData.mimeType)) out.push({ type: 'audio', data: p.inlineData.data, rate: 24000 });
            // Audio transcription is canonical; model text may duplicate it or contain internal reasoning.
        });
        const calls = message.toolCall && message.toolCall.functionCalls || [];
        if (calls.length > 8) return [{ type: 'error', code: 'TOOL_LIMIT' }];
        calls.forEach((c) => out.push({ type: 'tool', id: c.id, name: c.name, args: c.args }));
        if (message.toolCallCancellation) out.push({ type: 'cancel', ids: message.toolCallCancellation.ids || [] });
        if (content.turnComplete) out.push({ type: 'turn' });
        if (message.goAway) out.push({ type: 'error', code: 'SESSION_EXPIRED' });
    }
    return out;
}
module.exports = { connection, setup, textInput, toolResult, events };
