'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const hls = require('../../native/javi-carlab/tdt-dash-hls');
const fixture = (first = 100, at = 240000) => `<MPD type="dynamic"><Period>
<AdaptationSet contentType="video" codecs="avc1.4D401F"><Representation id="v" width="640" height="360" bandwidth="400000">
<SegmentTemplate timescale="600" startNumber="${first}" initialization="v.mp4" media="v-$Time$.m4s"><SegmentTimeline><S t="${at}" d="2400" r="10"/></SegmentTimeline></SegmentTemplate>
</Representation></AdaptationSet>
<AdaptationSet contentType="audio" codecs="mp4a.40.2" lang="es"><Representation id="a" bandwidth="128000">
<SegmentTemplate timescale="48000" startNumber="99" initialization="a.mp4" media="a-$Number%05d$.m4s"><SegmentTimeline><S t="19008000" d="191488"/><S d="192512" r="10"/></SegmentTimeline></SegmentTemplate>
</Representation></AdaptationSet></Period></MPD>`;
const source = 'https://channel.example.org/manifest.mpd';
const convert = (xml, rewrite = (url) => url) => hls(xml, source, rewrite, (kind) => 'http://127.0.0.1/' + kind + '.m3u8');

test('DASH to HLS keeps segment identities, durations and independent audio sequence on live refresh', () => {
    const first = convert(fixture()), next = convert(fixture(101, 242400));
    assert(first.master.includes('AUDIO="audio"'));
    assert(first.master.includes('URI="http://127.0.0.1/audio.m3u8"'));
    assert(first.video.includes('#EXT-X-MEDIA-SEQUENCE:100\n'));
    assert(next.video.includes('#EXT-X-MEDIA-SEQUENCE:101\n'));
    assert(first.video.includes('v-240000.m4s')); assert(!next.video.includes('v-240000.m4s'));
    assert(next.video.includes('v-242400.m4s'));
    assert(first.audio.includes('#EXT-X-MEDIA-SEQUENCE:99\n'));
    assert(first.audio.includes('a-00099.m4s')); assert(first.audio.includes('a-00100.m4s'));
    assert(first.audio.includes('#EXTINF:' + 191488 / 48000 + ','));
    assert(!first.video.includes('#EXT-X-ENDLIST'));
    assert(convert(fixture().replace('dynamic', 'static')).video.endsWith('#EXT-X-ENDLIST\n'));
});

test('DASH to HLS registers four reusable templates rather than one asset per live segment', () => {
    const registered = [];
    convert(fixture(), (url) => { registered.push(url); return url; });
    assert.equal(registered.length, 4);
    assert(registered.some((url) => url.includes('$Time$')));
    assert(registered.some((url) => url.includes('$Number%05d$')));
});

test('DASH to HLS rejects unbounded, unsafe and discontinuous timelines without inventing media times', () => {
    for (const invalid of [fixture().replace('r="10"', 'r="-1"'), fixture().replace('r="10"', 'r="5000"'),
        fixture().replace('t="240000"', 't="9999999999999999"'), fixture().replace('<S d="192512"', '<S t="1" d="192512"')]) {
        assert.throws(() => convert(invalid));
    }
});
