'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');

require('./tuyaCluster');

const DP_CONTROL = 0x01;
const DP_POSITION = 0x02;
const DP_POSITION_REPORT = 0x03;
const DP_CALIBRATION = 0x04;
const DP_DIRECTION = 0x05;
const DP_TYPE_VALUE = 0x02;
const DP_TYPE_ENUM = 0x04;

const COMMAND_OPEN = 0x00;
const COMMAND_STOP = 0x01;
const COMMAND_CLOSE = 0x02;
const COMMAND_CALIBRATE = 0x00;

const DIRECTION_FORWARD = 0x00;
const DIRECTION_REVERSE = 0x01;

const STATE_UP = 'up';
const STATE_DOWN = 'down';
const STATE_IDLE = 'idle';

module.exports = class MioDecorComfortDevice extends ZigBeeDevice {

  /**
   * onInit is called when the device is initialized.
   */
  async onNodeInit({ zclNode }) {
    this.log('MioDecorComfortDevice has been initialized');

    this._packetId = 0;
    this._lastPosition = null;
    this._tuyaCluster = zclNode.endpoints[1]?.clusters?.tuya;

    if (!this._tuyaCluster) {
      this.error('Tuya cluster not found on endpoint 1');
      return;
    }

    this._tuyaCluster.onTyDataReport = ({ data }) => this._handleTuyaData(data);
    this._tuyaCluster.onTyDataResponse = ({ data }) => this._handleTuyaData(data);

    this.registerCapabilityListener('windowcoverings_set', this._onSetPosition.bind(this));
    this.registerCapabilityListener('windowcoverings_state', this._onSetState.bind(this));
    this.registerCapabilityListener('windowcoverings_closed', this._onSetClosed.bind(this));
  }

  _handleTuyaData(data) {
    const parsed = this._parseTuyaPayload(data);
    if (!parsed) {
      return;
    }

    const { dp, dpType, payload } = parsed;

    if (dp === DP_CONTROL) {
      this._handleControlCommand(payload);
      return;
    }

    if (dp === DP_POSITION || dp === DP_POSITION_REPORT) {
      const position = this._parsePosition(dpType, payload);
      if (position === null) {
        return;
      }
      this._updatePosition(position);
    }
  }

  _handleControlCommand(payload) {
    const command = payload[0];
    if (command === COMMAND_OPEN) {
      if (this._isDirectionReversed()) {
        this._setState(STATE_DOWN);
        return;
      }
      this._setState(STATE_UP);
    } else if (command === COMMAND_CLOSE) {
      if (this._isDirectionReversed()) {
        this._setState(STATE_UP);
        return;
      }
      this._setState(STATE_DOWN);
    } else if (command === COMMAND_STOP) {
      this._setState(STATE_IDLE);
    }
  }

  _parseTuyaPayload(data) {
    if (!Buffer.isBuffer(data) || data.length < 6) {
      this.debug('Invalid Tuya payload', data);
      return null;
    }

    const dp = data.readUInt8(2);
    const dpType = data.readUInt8(3);
    const length = data.readUInt16BE(4);
    if (data.length < 6 + length) {
      this.debug('Tuya payload length mismatch', { dataLength: data.length, length });
      return null;
    }

    return {
      dp,
      dpType,
      payload: data.slice(6, 6 + length),
    };
  }

  _parsePosition(dpType, payload) {
    if (dpType !== DP_TYPE_VALUE || payload.length < 4) {
      return null;
    }

    const value = payload.readUInt32BE(0);
    return Math.max(0, Math.min(100, value));
  }

  async _updatePosition(position) {
    const normalized = this._normalizePositionFromDevice(position);
    const setValue = normalized / 100;

    this._lastPosition = normalized;

    await this.setCapabilityValue('windowcoverings_set', setValue);
    await this.setCapabilityValue('windowcoverings_closed', normalized === 0);
    await this._setState(STATE_IDLE);
  }

  async _setState(state) {
    if (this.hasCapability('windowcoverings_state')) {
      await this.setCapabilityValue('windowcoverings_state', state);
    }
  }

  async _onSetPosition(value) {
    const position = Math.round(value * 100);

    if (this._lastPosition !== null) {
      const direction = position > this._lastPosition ? STATE_UP : STATE_DOWN;
      if (position !== this._lastPosition) {
        await this._setState(direction);
      }
    }

    const devicePosition = this._normalizePositionForDevice(position);
    await this._sendTuyaCommand(DP_POSITION, DP_TYPE_VALUE, this._encodeValue(devicePosition));
  }

  async _onSetState(value) {
    if (value === STATE_UP) {
      const command = this._isDirectionReversed() ? COMMAND_CLOSE : COMMAND_OPEN;
      await this._sendTuyaCommand(DP_CONTROL, DP_TYPE_ENUM, Buffer.from([command]));
    } else if (value === STATE_DOWN) {
      const command = this._isDirectionReversed() ? COMMAND_OPEN : COMMAND_CLOSE;
      await this._sendTuyaCommand(DP_CONTROL, DP_TYPE_ENUM, Buffer.from([command]));
    } else if (value === STATE_IDLE) {
      await this._sendTuyaCommand(DP_CONTROL, DP_TYPE_ENUM, Buffer.from([COMMAND_STOP]));
    }
  }

  async _onSetClosed(value) {
    await this._onSetState(value ? STATE_DOWN : STATE_UP);
  }

  async _sendTuyaCommand(dp, dpType, payload) {
    if (!this._tuyaCluster) {
      this.error('Tuya cluster not initialized');
      return;
    }

    this._packetId = (this._packetId + 1) % 0x10000;

    const header = Buffer.alloc(6);
    header.writeUInt16BE(this._packetId, 0);
    header.writeUInt8(dp, 2);
    header.writeUInt8(dpType, 3);
    header.writeUInt16BE(payload.length, 4);

    const data = Buffer.concat([header, payload]);
    await this._tuyaCluster.tyDataRequest({ data }, { waitForResponse: false });
  }

  _encodeValue(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(Math.max(0, Math.min(100, value)), 0);
    return buffer;
  }

  _isDirectionReversed() {
    return this.getSetting('reverse_direction') === true;
  }

  _normalizePositionFromDevice(position) {
    const normalized = Math.max(0, Math.min(100, position));
    if (this._isDirectionReversed()) {
      return 100 - normalized;
    }
    return normalized;
  }

  _normalizePositionForDevice(position) {
    const normalized = Math.max(0, Math.min(100, position));
    if (this._isDirectionReversed()) {
      return 100 - normalized;
    }
    return normalized;
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('reverse_direction')) {
      await this._sendTuyaCommand(
        DP_DIRECTION,
        DP_TYPE_ENUM,
        Buffer.from([newSettings.reverse_direction ? DIRECTION_REVERSE : DIRECTION_FORWARD]),
      );

      if (this._lastPosition !== null) {
        const updatedPosition = 100 - this._lastPosition;
        this._lastPosition = updatedPosition;
        await this.setCapabilityValue('windowcoverings_set', updatedPosition / 100);
        await this.setCapabilityValue('windowcoverings_closed', updatedPosition === 0);
        await this._setState(STATE_IDLE);
      }
    }

    if (changedKeys.includes('calibration')) {
      await this._sendTuyaCommand(DP_CALIBRATION, DP_TYPE_ENUM, Buffer.from([COMMAND_CALIBRATE]));
    }
  }

};
