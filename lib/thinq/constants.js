'use strict';

/**
 * Constants used to talk to the (unofficial) LG ThinQ v2 API.
 *
 * These values are the well-known application keys that the LG ThinQ mobile
 * app uses. They are not secret and are required for the gateway / OAuth
 * handshake. They are taken from the widely used community implementations
 * (e.g. homebridge-lg-thinq, wideq).
 */
module.exports = {
  GATEWAY_URL: 'https://route.lgthinq.com:46030/v1/service/application/gateway-uri',

  SVC_CODE: 'SVC202',
  CLIENT_ID: 'LGAO221A02',
  OAUTH_SECRET_KEY: 'c053c2a6ddeb7ad97cb0eed0dcb31cf8',
  OAUTH_CLIENT_KEY: 'LGAO722A02',
  APPLICATION_KEY: '6V1V8H2BN5P9ZQGOI5DAQ92YZBDO3EK9',

  API_KEY: 'VGhpblEyLjAgU0VSVklDRQ==',
  API_CLIENT_ID: 'c713ea8e50f657534ff8b9d373dfebfc2ed70b88285c26b8ade49868c0b164d9',

  // LG device type ids (subset) - we only really care about AC here.
  DeviceType: {
    AC: 401,
    AIR_PURIFIER: 402,
    DEHUMIDIFIER: 403,
    TV: 701,
  },

  // AC operation modes (airState.opMode)
  OpMode: {
    COOL: 0,
    DRY: 1,
    FAN: 2,
    HEAT: 4,
    AIR_CLEAN: 5,
    AUTO: 6,
  },

  // Wind strength (fan speed) values (airState.windStrength), per LG's standard
  // RAC enum. NOTE: the exact set a unit supports varies by model — the
  // authoritative mapping is the device's model JSON
  // (Value['airState.windStrength'].value_mapping). LOW/MID/HIGH are reliable.
  WindStrength: {
    SLOW: 0,
    SLOW_LOW: 1,
    LOW: 2,
    LOW_MID: 3,
    MID: 4,
    MID_HIGH: 5,
    HIGH: 6,
    POWER: 7,
    NATURE: 8,
  },

  // Snapshot keys we read from the device state.
  KEYS: {
    POWER: 'airState.operation',
    OP_MODE: 'airState.opMode',
    CURRENT_TEMP: 'airState.tempState.current',
    TARGET_TEMP: 'airState.tempState.target',
    WIND_STRENGTH: 'airState.windStrength',
    HUMIDITY: 'airState.humidity.current',
    ENERGY: 'airState.energy.onCurrent',
    VANE_VERTICAL: 'airState.wDir.vStep',
    VANE_HORIZONTAL: 'airState.wDir.hStep',
  },
};
