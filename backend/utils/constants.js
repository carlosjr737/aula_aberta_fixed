const CAMERAS = {
  subway: {
    name: 'Subway',
    rtsp: process.env.RTSP_SUBWAY
  },
  bolso: {
    name: 'Bolso',
    rtsp: process.env.RTSP_BOLSO
  }
};

const DEFAULT_DURATION_MIN = 60;

module.exports = { CAMERAS, DEFAULT_DURATION_MIN };
