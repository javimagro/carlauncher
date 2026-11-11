'use strict';

// Sample listings for the channel browser preview.
const channels = [
    { name: 'La 1', badge: '1', color: '#3976af', title: 'Rutas de España', start: '11:00', end: '12:00', progress: 0.17,
        summary: 'Un viaje por carreteras secundarias, pueblos y miradores. En esta etapa seguimos la luz del atardecer hasta el final del camino.' },
    { name: 'La 2', badge: '2', color: '#0099a7', title: 'Grandes documentales', start: '10:30', end: '11:30', progress: 0.58,
        summary: 'Una mirada a los paisajes que cambian con las estaciones y a las especies que encuentran refugio en ellos.' },
    { name: 'Antena 3', badge: 'A3', color: '#d94d22', title: 'Tu cara me suena', start: '10:30', end: '12:45', progress: 0.27,
        summary: 'Nuevas actuaciones y momentos entre bastidores antes de conocer la valoración del jurado.' },
    { name: 'Cuatro', badge: '4', color: '#dd292e', title: 'Volando voy', start: '10:10', end: '11:30', progress: 0.69,
        summary: 'El equipo visita una nueva localidad y conoce a sus vecinos a través de sus historias.' },
    { name: 'Telecinco', badge: '5', color: '#134786', title: 'Got Talent España', start: '08:25', end: '11:15', progress: 0.91,
        summary: 'Artistas de distintas disciplinas presentan sus números ante el público y el jurado.' },
    { name: 'laSexta', badge: '6', color: '#16734f', title: 'Equipo de investigación', start: '10:07', end: '11:05', progress: 0.96,
        summary: 'Un reportaje con entrevistas y trabajo de campo para seguir la historia desde su origen.' },
    { name: '24h', badge: '24h', color: '#ab2643', title: 'Noticias 24h', start: '11:00', end: '11:30', progress: 0.32,
        summary: 'Actualidad nacional e internacional con conexiones en directo y un repaso a los titulares.' },
    { name: 'Neox', badge: 'NX', color: '#8e6c19', title: 'Sesión de comedia', start: '10:57', end: '11:20', progress: 0.33,
        summary: 'Un episodio de comedia en el que un plan sencillo acaba complicando el día de todos.' },
    { name: 'Nova', badge: 'NV', color: '#8b3572', title: 'Historias de la tarde', start: '10:50', end: '11:55', progress: 0.29,
        summary: 'Una visita inesperada cambia el rumbo de una familia y reabre una conversación pendiente.' },
    { name: 'Mega', badge: 'MG', color: '#8e352e', title: 'Mundo en movimiento', start: '10:55', end: '11:50', progress: 0.42,
        summary: 'Personas que trabajan sobre ruedas explican cómo preparan sus recorridos más exigentes.' },
    { name: 'Clan', badge: 'CL', color: '#1a6e99', title: 'Aventuras animadas', start: '11:05', end: '11:30', progress: 0.12,
        summary: 'El grupo sale a explorar y descubre que la mejor forma de orientarse es trabajar en equipo.' },
    { name: 'Teledeporte', badge: 'TD', color: '#7c661e', title: 'Resumen deportivo', start: '11:00', end: '12:00', progress: 0.24,
        summary: 'Los momentos destacados de la jornada y el calendario de las próximas competiciones.' }
];

module.exports = { channels, visibleChannels: 8 };
