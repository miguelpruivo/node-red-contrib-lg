'use strict';

module.exports = function (RED) {
  function LgAcStatusNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.account = RED.nodes.getNode(config.account);
    node.deviceId = config.deviceId;
    node.emitPeriodic = config.emitPeriodic !== false; // default true
    node.emitOnChange = config.emitOnChange !== false; // default true
    node.includeRaw = !!config.includeRaw;

    if (!node.account) {
      node.status({ fill: 'red', shape: 'ring', text: 'no account' });
      return;
    }
    node.status({ fill: 'grey', shape: 'ring', text: 'waiting...' });

    const unsubscribe = node.account.subscribe((evt) => {
      if (node.deviceId && evt.deviceId !== node.deviceId) {
        return;
      }

      const isChange = evt.changed || evt.first;
      if (!node.emitPeriodic && !(node.emitOnChange && isChange)) {
        return;
      }

      const reason = evt.first ? 'initial' : (isChange ? 'change' : 'periodic');
      const msg = {
        topic: evt.deviceId,
        deviceId: evt.deviceId,
        name: evt.name,
        event: reason,
        changed: evt.changedKeys,
        payload: evt.parsed,
      };
      if (node.includeRaw) {
        msg.raw = evt.raw;
      }
      node.send(msg);

      const p = evt.parsed;
      node.status({
        fill: p.power ? 'green' : 'grey',
        shape: 'dot',
        text: (p.currentTemperature != null ? p.currentTemperature + '°C ' : '') + (p.power ? 'on' : 'off'),
      });
    });

    node.on('close', () => {
      if (unsubscribe) {
        unsubscribe();
      }
    });
  }

  RED.nodes.registerType('lg-ac-status', LgAcStatusNode);
};
