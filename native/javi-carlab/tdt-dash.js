'use strict';

const sax = require('./vendor/sax');
const { URL } = require('url');
const { mediaUrl } = require('./tdt-catalog');

// A deliberately bounded SegmentTemplate subset, not a general XML editor.
// Preserve the broadcaster's timeline; never repair discontinuities with time guesses.
function parse(bytes) {
    if (Buffer.byteLength(bytes) > 256 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(String(bytes))) throw new Error('MPD limitado');
    const parser = sax.parser(true), stack = [];
    let root, count = 0;
    parser.onopentag = (tag) => {
        if (++count > 8000 || stack.length >= 24) throw new Error('MPD limitado');
        const node = { name: tag.name, kind: tag.name.split(':').pop(), attrs: tag.attributes, children: [], text: '' };
        if (stack.length) stack[stack.length - 1].children.push(node);
        else if (root) throw new Error('MPD inválido');
        else root = node;
        stack.push(node);
    };
    parser.ontext = parser.oncdata = (text) => { if (stack.length) stack[stack.length - 1].text += text; };
    parser.onclosetag = () => stack.pop();
    parser.write(String(bytes)).close();
    if (!root || root.kind !== 'MPD') throw new Error('MPD inválido');
    return root;
}

const children = (node, name) => node.children.filter((child) => child.kind === name);
function one(node, name) {
    const nodes = children(node, name);
    if (nodes.length > 1) throw new Error('MPD ambiguo');
    return nodes[0];
}
function escape(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
function serialize(node) {
    return '<' + node.name + Object.keys(node.attrs).map((key) => ' ' + key + '="' + escape(node.attrs[key]) + '"').join('') + '>' +
        escape(node.text) + node.children.map(serialize).join('') + '</' + node.name + '>';
}
function base(node, inherited) {
    const entry = one(node, 'BaseURL');
    return entry ? new URL(entry.text.trim(), inherited).href : inherited;
}
function template(node, inherited) {
    if (children(node, 'ContentProtection').length || children(node, 'SegmentBase').length || children(node, 'SegmentList').length) {
        throw new Error('MPD no compatible');
    }
    const own = one(node, 'SegmentTemplate');
    if (!own) return inherited;
    return Object.assign({}, own, { attrs: Object.assign({}, inherited && inherited.attrs, own.attrs),
        children: own.children.length ? own.children : inherited ? inherited.children : [] });
}

function segmentParameters(value) {
    const parameters = [];
    const rest = value.replace(/\$(Number|Time)(?:%0(\d{1,2})d)?\$/g, (match, key, padding) => {
        const previous = parameters.find((p) => p.key === key);
        if ((previous && previous.match !== match) || (padding && (Number(padding) < 1 || Number(padding) > 20))) {
            throw new Error('Formato de plantilla no compatible');
        }
        if (!previous) parameters.push({ key, match });
        return '';
    });
    if (rest.includes('$')) throw new Error('Plantilla no compatible');
    return parameters;
}

function selectDash(bytes, source, rewrite, width = 640, height = 360) {
    const root = parse(bytes), periods = children(root, 'Period');
    if (periods.length !== 1) throw new Error('MPD multiperiodo');
    const period = periods[0], rootBase = base(root, source), periodBase = base(period, rootBase);
    const inherited = template(period, template(root));
    const candidates = [];
    children(period, 'AdaptationSet').forEach((set) => {
        const setBase = base(set, periodBase), setTemplate = template(set, inherited);
        children(set, 'Representation').forEach((rep) => {
            const a = Object.assign({}, set.attrs, rep.attrs);
            const kind = a.contentType || String(a.mimeType || '').split('/')[0];
            if (kind !== 'audio' && kind !== 'video') return;
            const codec = String(a.codecs || '');
            if (codec && !(kind === 'video' ? /^avc[13]/ : /^mp4a/).test(codec)) return;
            const segment = template(rep, setTemplate);
            if (!segment || !segment.attrs.media || !segment.attrs.initialization) throw new Error('MPD sin plantilla');
            const w = Number(a.width), h = Number(a.height), pixels = w * h;
            if (kind === 'video' && (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 4096 || h > 2160)) return;
            const spanish = /^(es|spa)(-|$)/i.test(a.lang || '');
            const main = children(set, 'Role').some((role) => role.attrs.value === 'main');
            candidates.push({ set, rep, kind, segment, url: base(rep, setBase), pixels,
                fits: w <= width && h <= height,
                audioScore: (spanish ? 2 : 0) + (main ? 1 : 0), bandwidth: Number(a.bandwidth) || 0 });
        });
    });
    const videos = candidates.filter((c) => c.kind === 'video').sort((a, b) =>
        Number(b.fits) - Number(a.fits) || (a.fits ? b.pixels - a.pixels : a.pixels - b.pixels) || a.bandwidth - b.bandwidth);
    const audios = candidates.filter((c) => c.kind === 'audio').sort((a, b) => b.audioScore - a.audioScore || a.bandwidth - b.bandwidth);
    if (!videos.length) throw new Error('MPD sin AVC');
    const selected = [videos[0]].concat(audios.length ? [audios[0]] : []);
    period.children = selected.map((c) => {
        const attrs = Object.assign({}, c.segment.attrs);
        ['media', 'initialization'].forEach((key) => {
            const relative = attrs[key].replace(/\$RepresentationID\$/g, () => c.rep.attrs.id || '')
                .replace(/\$Bandwidth\$/g, () => String(c.bandwidth));
            const url = mediaUrl(new URL(relative, c.url).href);
            if (!url || !url.startsWith('https://')) throw new Error('MPD requiere HTTPS');
            segmentParameters(url);
            attrs[key] = rewrite(url);
        });
        const segment = Object.assign({}, c.segment, { attrs });
        const rep = Object.assign({}, c.rep, { children: c.rep.children.filter((n) => n.kind === 'AudioChannelConfiguration').concat(segment) });
        return Object.assign({}, c.set, { children: c.set.children.filter((n) => ['Role', 'AudioChannelConfiguration'].includes(n.kind)).concat(rep) });
    });
    root.children = [period];
    return '<?xml version="1.0" encoding="UTF-8"?>' + serialize(root);
}

module.exports = { selectDash, segmentParameters };
