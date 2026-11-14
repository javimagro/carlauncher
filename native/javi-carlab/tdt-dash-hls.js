'use strict';

const { selectDash, parseMpd } = require('./tdt-dash');
const child = (node, kind) => node.children.find((item) => item.kind === kind);
const integer = (value) => {
    const n = Number(value);
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(n)) throw new Error('DASH integer outside supported range');
    return n;
};

// Repackage only playlist metadata. Media, timestamps and TLS stay unchanged.
// HLS owns live refresh/segment progression instead of dashdec's shared timelines.
function dashHls(bytes, source, rewrite, playlistUrl) {
    const root = parseMpd(selectDash(bytes, source, (url) => url));
    const period = child(root, 'Period');
    const tracks = period.children.map((set) => {
        const rep = child(set, 'Representation');
        const attrs = Object.assign({}, set.attrs, rep.attrs);
        const kind = attrs.contentType || String(attrs.mimeType).split('/')[0];
        const template = child(rep, 'SegmentTemplate');
        const timeline = child(template, 'SegmentTimeline');
        if (!timeline) throw new Error('DASH requires explicit segment timeline');
        const scale = integer(template.attrs.timescale || '1');
        if (!scale) throw new Error('DASH invalid timescale');
        const first = integer(template.attrs.startNumber || '1');
        const media = rewrite(template.attrs.media);
        let at = 0;
        const segments = [];
        timeline.children.forEach((s) => {
            if (s.kind !== 'S') throw new Error('DASH unsupported timeline entry');
            if (s.attrs.t !== undefined) at = integer(s.attrs.t);
            const duration = integer(s.attrs.d), repeat = integer(s.attrs.r || '0');
            if (!duration || repeat > 1024 || segments.length + repeat + 1 > 1024) throw new Error('DASH timeline limit');
            for (let i = 0; i <= repeat; i++) {
                const number = first + segments.length;
                if (!Number.isSafeInteger(number) || !Number.isSafeInteger(at + duration)) throw new Error('DASH timeline overflow');
                if (segments.length && at < segments[segments.length - 1].end) throw new Error('DASH overlapping timeline');
                // Gaps need an explicit discontinuity policy, not guessed timestamps.
                if (segments.length && at !== segments[segments.length - 1].end) throw new Error('DASH discontinuous timeline');
                const url = media.replace(/\$(Number|Time)(?:%0(\d{1,2})d)?\$/g, (_, key, width) => {
                    let value = String(key === 'Time' ? at : number);
                    while (width && value.length < Number(width)) value = '0' + value;
                    return value;
                });
                segments.push({ url, duration: duration / scale, end: at + duration });
                at += duration;
            }
        });
        if (!segments.length) throw new Error('DASH empty timeline');
        const initialization = rewrite(template.attrs.initialization);
        if (/[\r\n"]/.test(initialization)) throw new Error('Invalid local media URL');
        const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:' + Math.ceil(Math.max.apply(null, segments.map((s) => s.duration))),
            '#EXT-X-MEDIA-SEQUENCE:' + first, '#EXT-X-MAP:URI="' + initialization + '"'];
        segments.forEach((s) => {
            const url = s.url;
            if (/[\r\n]/.test(url)) throw new Error('Invalid local media URL');
            lines.push('#EXTINF:' + s.duration + ',', url);
        });
        if (root.attrs.type !== 'dynamic') lines.push('#EXT-X-ENDLIST');
        return { kind, bandwidth: Number(attrs.bandwidth) || 0, playlist: lines.join('\n') + '\n' };
    });
    const video = tracks.find((t) => t.kind === 'video'), audio = tracks.find((t) => t.kind === 'audio');
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7'];
    if (audio) lines.push('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="' + playlistUrl('audio') + '"');
    lines.push('#EXT-X-STREAM-INF:BANDWIDTH=' + Math.max(1, video.bandwidth + (audio ? audio.bandwidth : 0)) + (audio ? ',AUDIO="audio"' : ''), playlistUrl('video'));
    return { master: lines.join('\n') + '\n', video: video.playlist, audio: audio && audio.playlist };
}

module.exports = dashHls;
