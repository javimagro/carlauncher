'use strict';

// Contracts derived from MGU21 036.010.004; no firmware/SDK is distributed.
const services = {
    tuner: { name: 'de.bmw.infotainment.tuner.fmamdab.tunerfmamdab.TunerFmAmDab',
        attributes: ['currentStationFmDab', 'epgReferenceTime'], methods: ['getStationListMetaData', 'selectStation', 'triggerStationListBroadcast'], broadcasts: ['dataStationList'] },
    metadata: { name: 'de.bmw.infotainment.tuner.fmamdab.tunerfmamdab.TunerFmAmDabMetadata',
        attributes: [], methods: ['getStationListMetaData'] },
    media: { name: 'de.bmw.infotainment.entertainment.mediasource.MediaSource',
        attributes: ['sources', 'activeSourceId'], methods: ['selectSource'] }
};
const lists = [2, 7, 10]; // Receivable FM/DAB, BMW presets and BMW top stations.
const clean = (v, size) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, size || 100) : '';
const uint = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
const on = (v) => v === 1 || v === 'ON';
const bandNames = { WB_FM: 1, WB_MW: 2, WB_DAB: 3, WB_FM_DAB: 4 };
function picture(value) {
    // BMW ByteBufferData is a struct, not the encoded image itself.
    if (value && value.data !== undefined) value = value.data;
    if (!(Buffer.isBuffer(value) || value instanceof Uint8Array || Array.isArray(value)) || value.length > 96 * 1024 || value.length < 8) return null;
    const b = Buffer.from(value);
    return (b[0] === 255 && b[1] === 216) || b.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? b.toString('base64') : null;
}
function seconds(time) {
    return time && uint(time.hour, 23) && uint(time.minute, 59) && uint(time.second, 59) ? time.hour * 3600 + time.minute * 60 + time.second : null;
}
function programme(days) {
    // Only called for EPG_NOW_PLUS_1_EVENT requests: first event is the current programme.
    const first = Array.isArray(days) && days[0], event = first && Array.isArray(first.eventsList) && first.eventsList[0];
    if (!event) return null;
    const start = seconds(event.eventStartTime), end = seconds(event.eventEndTime);
    return start !== null && end !== null && start !== end ? { name: clean(event.eventName), start, end } : null;
}
function station(s, list, nowNext) {
    if (!s || !uint(s.dataBaseIdentifier, 0xffffffff) || !uint(s.positionNumber, 65535)) return null;
    const band = bandNames[s.waveBand] || s.waveBand;
    if (![1, 3, 4].includes(band)) return null; // Never select satellite/IP/TV/traffic sources through this card.
    const pty = uint(s.pty, 31) ? s.pty : 0;
    const european = s.ptyTableType === 0 || s.ptyTableType === 'PTT_RDS_DAB';
    const frequency = Number.isFinite(s.frequencyKhz) && s.frequencyKhz >= 65000 && s.frequencyKhz <= 108000 ? s.frequencyKhz / 1000 : null;
    return { id: s.dataBaseIdentifier, position: s.positionNumber, list: list,
        key: String(s.dataBaseIdentifier), memoryKey: band + ':' + (uint(s.id, 0xffffffff) && s.id ? 's' + s.id : frequency ? 'f' + frequency : 'n' + clean(s.stationLongName || s.stationShortName)),
        band: band === 3 ? 'DAB' : band === 4 ? 'FM/DAB' : 'FM', frequency,
        name: clean(s.stationLongName) || clean(s.stationShortName) || (frequency ? frequency.toFixed(1) + ' MHz' : 'Emisora'),
        title: clean(s.titleName), artist: clean(s.artistName), programme: nowNext ? programme(s.epgDayViewsList) : null, favorite: on(s.isFavorite),
        category: european && pty === 4 ? 'sports' : european && ([10, 11, 12, 13, 14, 15, 24, 25, 26, 27, 28].includes(pty)) ? 'music' : '',
        receptionLost: [2, 3, 'DIGITAL_INTERRUPTED', 'DIGITAL_SIGNAL_LOST'].includes(s.receptionMode) };
}
function sources(values) {
    const types = { TUNER_FM: 1, TUNER_PRESETS: 2, TUNER_RADIO: 4 };
    return (Array.isArray(values) ? values.slice(0, 40) : []).filter((s) => s &&
        [1, 2, 4].includes(types[s.playerType] || s.playerType) && typeof s.sourceId === 'string' && s.sourceId.length <= 200)
        .map((s) => ({ id: s.sourceId, name: clean(s.displayText), selectable: s.selectable === true,
            type: types[s.playerType] || s.playerType }));
}
const listNames = { LT_RECEIVABLE_FM_DAB: 2, LT_PRESETS_RADIO: 7, LT_TOPSTATIONS_RADIO: 10 };
function listType(value) { return lists.includes(value) ? value : listNames[value]; }
module.exports = { services, lists, station, sources, picture, clean, seconds, listType };
