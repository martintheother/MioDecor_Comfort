'use strict';

const { Cluster, ZCLDataTypes } = require('zigbee-clusters');

const COMMANDS = {
  tyDataRequest: {
    id: 0x00,
    args: {
      data: ZCLDataTypes.buffer,
    },
  },
  tyDataResponse: {
    id: 0x01,
    args: {
      data: ZCLDataTypes.buffer,
    },
  },
  tyDataReport: {
    id: 0x02,
    args: {
      data: ZCLDataTypes.buffer,
    },
  },
  tyDataQuery: {
    id: 0x03,
    args: {
      data: ZCLDataTypes.buffer,
    },
  },
};

class TuyaCluster extends Cluster {
  static get ID() {
    return 0xEF00;
  }

  static get NAME() {
    return 'tuya';
  }

  static get COMMANDS() {
    return COMMANDS;
  }
}

Cluster.addCluster(TuyaCluster);

module.exports = TuyaCluster;
