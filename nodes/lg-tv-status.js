'use strict';

module.exports = function (RED) {
  function LgTvStatusNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.tvConfig = RED.nodes.getNode(config.tv);
    node.emitInitial = config.emitInitial !== false;

    if (!node.tvConfig) {
      node.status({ fill: 'red', shape: 'ring', text: 'no TV' });
      return;
    }
    node.status({ fill: 'grey', shape: 'ring', text: 'waiting...' });

    const tv = node.tvConfig.getTv();

    const emit = (state) => {
      node.send({
        topic: tv.name,
        payload: { power: state.power, state: state.state, connected: state.connected },
        event: state.power ? 'on' : 'off',
      });
      node.status({
        fill: state.power ? 'green' : 'grey',
        shape: 'dot',
        text: state.power ? 'on' : 'off',
      });
    };

    const handler = (info) => {
      emit(tv.getState());
    };

    tv.on('powerStateChanged', handler);

    // Emit the current state once on deploy, if already known.
    if (node.emitInitial) {
      setTimeout(() => {
        const st = tv.getState();
        if (st.power !== null) {
          emit(st);
        }
      }, 100);
    }

    node.on('close', () => {
      tv.removeListener('powerStateChanged', handler);
    });
  }

  RED.nodes.registerType('lg-tv-status', LgTvStatusNode);
};
