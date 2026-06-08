'use strict';

const dgram = require('dgram');

/**
 * Send a Wake-on-LAN "magic packet" to a MAC address.
 *
 * No external dependency: the magic packet is 6 bytes of 0xFF followed by the
 * 6-byte MAC repeated 16 times, sent as a UDP broadcast.
 *
 * @param {string} mac           MAC address (AA:BB:CC:DD:EE:FF, AA-BB-..., or AABBCCDDEEFF)
 * @param {object} [opts]
 * @param {string} [opts.address='255.255.255.255'] broadcast address
 * @param {number} [opts.port=9]                    UDP port (7 or 9 are common)
 * @param {number} [opts.count=3]                   number of packets to send
 * @returns {Promise<void>}
 */
function wake(mac, opts = {}) {
  const address = opts.address || '255.255.255.255';
  const port = opts.port || 9;
  const count = opts.count || 3;

  const macBytes = parseMac(mac);
  const magic = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) {
    macBytes.copy(magic, 6 + i * 6);
  }

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let remaining = count;
    let settled = false;

    const done = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.close();
      } catch (e) {
        /* ignore */
      }
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    socket.once('error', done);

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch (e) {
        return done(e);
      }
      const sendOne = () => {
        socket.send(magic, 0, magic.length, port, address, (err) => {
          if (err) {
            return done(err);
          }
          remaining -= 1;
          if (remaining > 0) {
            setTimeout(sendOne, 120);
          } else {
            done();
          }
        });
      };
      sendOne();
    });
  });
}

function parseMac(mac) {
  if (typeof mac !== 'string') {
    throw new Error('WoL: MAC address must be a string');
  }
  const hex = mac.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) {
    throw new Error(`WoL: invalid MAC address "${mac}"`);
  }
  return Buffer.from(hex, 'hex');
}

module.exports = { wake, parseMac };
