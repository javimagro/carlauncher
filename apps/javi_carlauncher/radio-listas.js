'use strict';

const { lists, listType, station } = require('./radio-datos.js');

// Full broadcasts replace a list; incremental broadcasts update BMW database IDs.
// Revisions belong to a list, so a favourites event cannot discard the FM/DAB page.
function createLists(now) {
    const pages = {}, revisions = {};
    const revision = (list) => revisions[list] || 0;
    function rows(list) {
        const page = pages[list];
        return page && now() - page.at < 90000 ? page.rows : [];
    }
    function commit(list, raw, seen, nowNext) {
        if (seen !== revision(list) || !Array.isArray(raw) || raw.length > 500) return false;
        const found = new Map();
        raw.forEach((v) => { const s = station(v, list, nowNext); if (s) found.set(s.key, s); });
        pages[list] = { rows: Array.from(found.values()).sort((a, b) => a.position - b.position), at: now(), revision: seen };
        return true;
    }
    function receive(event) {
        const list = listType(event && event.listType);
        if (!list) return true; // An AM/TV list event does not invalidate FM/DAB.
        const previous = pages[list], fresh = previous && previous.revision === revision(list) && now() - previous.at < 90000;
        revisions[list] = revision(list) + 1;
        if (!Array.isArray(event.stationList) || event.stationList.length > 500 ||
            ![0, 1, 'OFF', 'ON'].includes(event.isIncrementalUpdate)) return false;
        if (event.isIncrementalUpdate === 0 || event.isIncrementalUpdate === 'OFF') return commit(list, event.stationList, revision(list), false);
        // Without a base, an incremental fragment must not masquerade as a complete list.
        if (!fresh) return false;
        const updated = new Map(previous.rows.map((v) => [v.key, v]));
        event.stationList.forEach((v) => { const s = station(v, list); if (s) updated.set(s.key, s); });
        if (updated.size > 500) return false;
        pages[list] = { rows: Array.from(updated.values()).sort((a, b) => a.position - b.position), at: now(), revision: revision(list) };
        return true;
    }
    return { revision, commit, receive,
        all: () => lists.reduce((all, list) => all.concat(rows(list)), []),
        find(key, list) {
            const page = pages[list];
            return page && page.revision === revision(list) && rows(list).find((v) => v.key === key);
        }
    };
}
module.exports = { createLists };
