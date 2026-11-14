'use strict';

const { matching } = require('./assistant-tools');
const { cards } = require('./drivehub-state');
function createCommands(context) {
    const { panel, radio, tdt, navigation, data, vehicle, weather } = context;
    return async (name, args, alive) => {
        if (!alive()) return { status: 'cancelled' };
        if (name === 'set_radio_station') return radio.playNamed(args.station, alive);
        if (name === 'list_radio_stations') return { status: 'ok', stations: radio.allStations().slice(0, 120).map((s) => s.name) };
        if (name === 'set_radio_category') {
            radio.state.filters = args.category === 'all' ? [] : [args.category]; radio.state.index = radio.state.top = 0;
            radio.open(); panel.selectCard(1); return { status: 'shown', category: args.category };
        }
        if (name === 'set_radio_favorite') {
            const found = matching(radio.allStations(), args.station);
            if (found.length !== 1) return { status: found.length ? 'selection_required' : 'not_found', candidates: found.slice(0, 8).map((s) => s.name) };
            if (radio.favorite(found[0]) !== args.enabled) radio.toggleFavorite(found[0]);
            return { status: 'updated', scope: 'Favoritos locales de BMWLauncher', station: found[0].name };
        }
        if (name === 'list_tv_channels' || name === 'play_tv_channel') {
            const status = await tdt.prepareChannels(alive);
            if (!alive()) return { status: 'cancelled' };
            if (status !== 'ready') return { status, message: 'El catálogo TDT todavía no está disponible. Vuelve a intentarlo.' };
            if (name === 'list_tv_channels') return { status: 'ok', channels: tdt.state.channels.slice(0, 100).map((s) => s.name) };
            const candidates = matching(tdt.state.channels, args.channel);
            if (candidates.length !== 1) return { status: candidates.length ? 'selection_required' : 'not_found', candidates: candidates.slice(0, 8).map((s) => s.name) };
            panel.selectCard(cards.findIndex((c) => c.id === 'tdtworld'));
            tdt.playNamed(candidates[0].id); return { status: 'requested', channel: candidates[0].name };
        }
        if (name === 'show_drivehub_card') {
            const i = cards.findIndex((c) => c.id === args.card);
            if (i < 0) return { status: 'error' };
            panel.selectCard(i); return { status: 'shown', card: args.card };
        }
        if (name === 'get_vehicle_status') return { status: 'ok', readings: vehicle(), units: { soc: '%', range: 'km', outside: '°C', batteryTemperature: '°C', speed: 'km/h', power: 'kW' } };
        if (name === 'get_current_location') return { status: vehicle().location ? 'ok' : 'unavailable', position: vehicle().location || null };
        if (name === 'get_navigation_status') {
            const n = navigation.state.nav || {}, c = navigation.state.controls || {};
            return { status: n.state || 'unavailable', routeStatus: n.routeStatus, destinations: n.destinations,
                search: { status: c.status, results: (c.results || []).slice(0, 8).map((r) => ({ name: r.name, distanceMetres: r.metres })) } };
        }
        if (name === 'navigate_to' || name === 'search_pois') {
            const text = args.destination || args.query;
            return navigation.assistantSearch(text, name === 'search_pois' && /cargador|recarga|charging/i.test(text));
        }
        if (name === 'get_weather_forecast') return { status: data.weatherStatus, forecast: weather() };
        if (name === 'search_drivehub_news') {
            const candidates = matching((data.news || []).map((a, index) => ({ name: a.title, index, article: a })), args.query);
            if (!candidates.length) return { status: 'not_found', message: 'No hay coincidencias en las noticias descargadas' };
            panel.selectCard(3); panel.setArticleCount(data.news.length, candidates[0].index);
            return { status: 'shown', articles: candidates.slice(0, 5).map((a) => ({ title: a.article.title, summary: a.article.summary, url: a.article.url })) };
        }
        if (name === 'get_bmwlauncher_settings') return { status: 'ok', theme: navigation.state.theme, navigation: navigation.state.preferences };
        if (name === 'set_bmwlauncher_setting') { navigation.setTheme(args.theme); return { status: 'updated', theme: navigation.state.theme }; }
        return { status: 'unavailable' };
    };
}
module.exports = { createCommands };
