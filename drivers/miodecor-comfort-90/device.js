'use strict';

const { ZigBeeDevice } = require('homey-zigbeedriver');
const { BasicCluster } = require('zigbee-clusters');

require('./tuyaCluster');

const DP_CONTROL = 0x01;
const DP_POSITION = 0x02;
const DP_POSITION_REPORT = 0x03;
const DP_CALIBRATION = 0x04;
const DP_DIRECTION = 0x05;
const DP_ARRIVED = 0x06;
const DP_WORK_STATE = 0x07;
const DP_TYPE_VALUE = 0x02;
const DP_TYPE_ENUM = 0x04;

const COMMAND_OPEN = 0x00;
const COMMAND_STOP = 0x01;
const COMMAND_CLOSE = 0x02;
const COMMAND_CALIBRATE = 0x00;

const DIRECTION_FORWARD = 0x00;
const DIRECTION_REVERSE = 0x01;

const WORK_STATE_OPENING = 0x00;
const WORK_STATE_CLOSING = 0x01;
const WORK_STATE_STOPPED = 0x02;

const STATE_UP = 'up';
const STATE_DOWN = 'down';
const STATE_IDLE = 'idle';

const AUTO_CALIBRATION_STORE_KEY = 'auto_calibrated';
const AUTO_CALIBRATION_MOVES = 2;

const KEEP_ALIVE_INTERVAL = 30 * 60 * 1000;
const MAGIC_PACKET = Buffer.from([0x00, 0x00, 0x00, 0x00]);

module.exports = class MioDecorComfortDevice extends ZigBeeDevice {

  /**
   * onInit is called when the device is initialized.
   */
  async onNodeInit({ zclNode }) {
    this.log('MioDecorComfortDevice has been initialized');

    this._packetId = 0;
    this._lastPosition = null;
    this._pendingTarget = null;
    this._lastDirection = null;
    this._autoCalibrating = false;
    this._autoCalibrationMovesLeft = 0;
    this._autoCalibrationDirection = null;
    this._advancedParams = {};
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

    if (this.hasCapability('onoff')) {
      this.registerCapabilityListener('onoff', this._onToggle.bind(this));
    }

    this._parseAdvancedParams();

    await this._configureReporting();
    await this._maybeStartAutoCalibration();
    await this._applyStateOverride(this.getSetting('state_override'));

    await this._sendMagicPacket();
    this._keepAliveInterval = this.homey.setInterval(() => {
      this._sendMagicPacket().catch((error) => this.error('Failed to send keep-alive', error));
    }, KEEP_ALIVE_INTERVAL);
  }

  async _configureReporting() {
    try {
      await this.configureAttributeReporting([
        {
          cluster: BasicCluster,
          attributeName: 'appVersion',
          minInterval: 30,
          maxInterval: 300,
          minChange: 1,
        },
      ]);
    } catch (error) {
      this.error('Failed to configure reporting', error);
    }
  }

  _parseAdvancedParams() {
    const params = {};
    const raw = this.getSetting('advanced_params');
    if (typeof raw === 'string' && raw.trim().length > 0) {
      const normalized = raw.toLowerCase().replace(/\s+/g, '');
      for (const entry of normalized.split(',')) {
        if (!entry) {
          continue;
        }
        const [key, value] = entry.split('=');
        if (!key || value === undefined) {
          continue;
        }
        if (value === 'true') {
          params[key] = true;
        } else if (value === 'false') {
          params[key] = false;
        } else if (!Number.isNaN(Number(value))) {
          params[key] = Number(value);
        } else {
          params[key] = value;
        }
      }
    }

    this._advancedParams = params;
  }

  _getAdvancedParams() {
    return this._advancedParams || {};
  }

  _getAdvancedParam(name) {
    return this._getAdvancedParams()[name];
  }

  async _maybeStartAutoCalibration() {
    if (this.getStoreValue(AUTO_CALIBRATION_STORE_KEY)) {
      return;
    }

    this._autoCalibrating = true;
    this._autoCalibrationMovesLeft = AUTO_CALIBRATION_MOVES;
    this._autoCalibrationDirection = STATE_UP;
    await this._startAutoCalibrationMove();
  }

  async _startAutoCalibrationMove() {
    if (!this._autoCalibrating) {
      return;
    }

    await this._onSetState(this._autoCalibrationDirection);
  }

  async _handleCalibrationPosition(position) {
    if (!this._autoCalibrating) {
      return;
    }

    if (position !== 0 && position !== 100) {
      return;
    }

    this._autoCalibrationMovesLeft -= 1;

    if (this._autoCalibrationMovesLeft <= 0) {
      this._autoCalibrating = false;
      await this.setStoreValue(AUTO_CALIBRATION_STORE_KEY, true);
      return;
    }

    this._autoCalibrationDirection = this._autoCalibrationDirection === STATE_UP
      ? STATE_DOWN
      : STATE_UP;

    await this._startAutoCalibrationMove();
  }

  async _applyStateOverride(value) {
    if (value === 'open') {
      await this._setLogicalPosition(100);
    } else if (value === 'closed') {
      await this._setLogicalPosition(0);
    } else if (value === 'unknown') {
      this._lastPosition = null;
      this._pendingTarget = null;
    }
  }

  async _handleTuyaData(data) {
    const parsed = this._parseTuyaPayload(data);
    if (!parsed) {
      return;
    }

    const { dp, dpType, payload } = parsed;

    if (dp === DP_CONTROL) {
      this._handleControlCommand(payload);
      return;
    }

    if (dp === DP_POSITION) {
      await this._handlePositionCommand(dpType, payload);
      return;
    }

    if (dp === DP_POSITION_REPORT) {
      await this._handlePositionReport(dpType, payload);
      return;
    }

    if (dp === DP_DIRECTION) {
      this._handleDirectionCommand(dpType, payload);
      return;
    }

    if (dp === DP_WORK_STATE) {
      await this._handleWorkState(dpType, payload);
      return;
    }

    if (dp === DP_ARRIVED) {
      await this._handleArrivedDataPoint(dpType, payload);
    }
  }

  _handleControlCommand(payload) {
    const command = payload[0];
    if (command === COMMAND_OPEN) {
      this._pendingTarget = 100;
      if (this._isDirectionReversed()) {
        this._setState(STATE_DOWN);
        return;
      }
      this._setState(STATE_UP);
    } else if (command === COMMAND_CLOSE) {
      this._pendingTarget = 0;
      if (this._isDirectionReversed()) {
        this._setState(STATE_UP);
        return;
      }
      this._setState(STATE_DOWN);
    } else if (command === COMMAND_STOP) {
      this._setState(STATE_IDLE);
    }
  }

  _handleDirectionCommand(dpType, payload) {
    if (dpType !== DP_TYPE_ENUM || payload.length < 1) {
      return;
    }

    this._deviceDirection = payload[0];
  }

  async _handlePositionCommand(dpType, payload) {
    const position = this._parsePosition(dpType, payload);
    if (position === null) {
      return;
    }

    if (this._treatDp2AsReport()) {
      await this._updatePosition(position);
      return;
    }

    const normalized = this._normalizePositionFromDevice(position);
    this._pendingTarget = normalized;

    if (this._lastPosition !== null && normalized !== this._lastPosition) {
      await this._setState(normalized > this._lastPosition ? STATE_UP : STATE_DOWN);
    }
  }

  async _handlePositionReport(dpType, payload) {
    const position = this._parsePosition(dpType, payload);
    if (position === null) {
      return;
    }

    await this._updatePosition(position);
  }

  async _handleWorkState(dpType, payload) {
    if (dpType === DP_TYPE_VALUE) {
      const position = this._parsePosition(dpType, payload);
      if (position === null) {
        return;
      }
      await this._updatePosition(position);
      return;
    }

    if (dpType !== DP_TYPE_ENUM || payload.length < 1) {
      return;
    }

    const workState = payload[0];
    if (workState === WORK_STATE_OPENING) {
      await this._setState(this._isDirectionReversed() ? STATE_DOWN : STATE_UP);
    } else if (workState === WORK_STATE_CLOSING) {
      await this._setState(this._isDirectionReversed() ? STATE_UP : STATE_DOWN);
    } else if (workState === WORK_STATE_STOPPED) {
      await this._setState(STATE_IDLE);
    }
  }

  async _handleArrivedDataPoint(dpType, payload) {
    if (dpType === DP_TYPE_VALUE) {
      const position = this._parsePosition(dpType, payload);
      if (position === null) {
        return;
      }
      await this._updatePosition(position);
      return;
    }

    if (dpType === DP_TYPE_ENUM && payload.length > 0 && payload[0] === 0x00) {
      if (this._pendingTarget !== null) {
        await this._setLogicalPosition(this._pendingTarget);
        await this._handleCalibrationPosition(this._pendingTarget);
      }
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
    await this._setLogicalPosition(normalized);
    await this._handleCalibrationPosition(normalized);
  }

  async _setLogicalPosition(position) {
    const normalized = Math.max(0, Math.min(100, position));
    const setValue = normalized / 100;

    this._lastPosition = normalized;
    this._pendingTarget = null;

    await this.setCapabilityValue('windowcoverings_set', setValue);
    await this.setCapabilityValue('windowcoverings_closed', normalized === 0);
    await this._setOnOffState(normalized);
    await this._setState(STATE_IDLE);
  }

  async _setState(state) {
    if (state === STATE_UP || state === STATE_DOWN) {
      this._lastDirection = state;
    }

    if (this.hasCapability('windowcoverings_state')) {
      await this.setCapabilityValue('windowcoverings_state', state);
    }
  }

  _isMoving() {
    const state = this.getCapabilityValue('windowcoverings_state');
    return state === STATE_UP || state === STATE_DOWN;
  }

  async _setOnOffState(position) {
    if (!this.hasCapability('onoff')) {
      return;
    }

    let onoff;
    if (position === 0) {
      onoff = false;
    } else if (position === 100) {
      onoff = true;
    } else if (this._lastDirection === STATE_DOWN) {
      onoff = false;
    } else {
      onoff = true;
    }

    await this.setCapabilityValue('onoff', onoff);
  }

  async _onSetPosition(value) {
    if (this._autoCalibrating) {
      return;
    }

    const position = Math.round(value * 100);
    await this._applyTargetPosition(position);
  }

  async _onSetState(value) {
    if (value === STATE_IDLE && this._autoCalibrating) {
      return;
    }

    if (value === STATE_UP) {
      const command = this._isDirectionReversed() ? COMMAND_CLOSE : COMMAND_OPEN;
      this._pendingTarget = this._isDirectionReversed() ? 0 : 100;
      await this._sendTuyaCommand(DP_CONTROL, DP_TYPE_ENUM, Buffer.from([command]));
    } else if (value === STATE_DOWN) {
      const command = this._isDirectionReversed() ? COMMAND_OPEN : COMMAND_CLOSE;
      this._pendingTarget = this._isDirectionReversed() ? 100 : 0;
      await this._sendTuyaCommand(DP_CONTROL, DP_TYPE_ENUM, Buffer.from([command]));
    } else if (value === STATE_IDLE) {
      await this._sendTuyaCommand(DP_CONTROL, DP_TYPE_ENUM, Buffer.from([COMMAND_STOP]));
    }
  }

  async _onSetClosed(value) {
    if (this._autoCalibrating) {
      return;
    }

    if (this._isMoving()) {
      await this._onSetState(STATE_IDLE);
      return;
    }

    await this._onSetState(value ? STATE_DOWN : STATE_UP);
  }

  async _onToggle() {
    if (this._autoCalibrating) {
      return;
    }

    if (this._isMoving()) {
      await this._onSetState(STATE_IDLE);
      return;
    }

    await this._toggleDirection();
  }

  async _toggleDirection() {
    if (this._lastPosition === null) {
      await this._onSetState(STATE_UP);
      return;
    }

    if (this._lastPosition <= 0) {
      await this._onSetState(STATE_UP);
      return;
    }

    if (this._lastPosition >= 100) {
      await this._onSetState(STATE_DOWN);
      return;
    }

    const nextDirection = this._lastDirection === STATE_UP ? STATE_DOWN : STATE_UP;
    await this._onSetState(nextDirection);
  }

  async _applyTargetPosition(position) {
    const target = Math.max(0, Math.min(100, position));

    if (this._lastPosition !== null) {
      const direction = target > this._lastPosition ? STATE_UP : STATE_DOWN;
      if (target !== this._lastPosition) {
        await this._setState(direction);
      }
    }

    if (this._shouldReplaceSetLevel(target) && (target === 0 || target === 100)) {
      await this._onSetState(target === 0 ? STATE_DOWN : STATE_UP);
      return;
    }

    this._pendingTarget = target;
    const devicePosition = this._normalizePositionForDevice(target);
    await this._sendTuyaCommand(DP_POSITION, DP_TYPE_VALUE, this._encodeValue(devicePosition));
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

  async _sendMagicPacket() {
    if (!this._tuyaCluster) {
      return;
    }

    await this._tuyaCluster.tyDataQuery({ data: MAGIC_PACKET }, { waitForResponse: false });
  }

  _encodeValue(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(Math.max(0, Math.min(100, value)), 0);
    return buffer;
  }

  _isDirectionReversed() {
    return this.getSetting('reverse_direction') === true;
  }

  _shouldInvertPosition(settings = this.getSettings()) {
    const reverse = settings.reverse_direction === true;
    const invert = settings.fix_percent === true;
    return reverse !== invert;
  }

  _shouldReplaceSetLevel(target) {
    const params = this._getAdvancedParams();
    if (target === 0) {
      return params.replace_setlevel_0_with_close === true;
    }
    if (target === 100) {
      return params.replace_setlevel_100_with_open === true;
    }
    return false;
  }

  _treatDp2AsReport() {
    return this.getSetting('dp2_as_report') === true || this._getAdvancedParam('dp2_as_report') === true;
  }

  _normalizePositionFromDevice(position) {
    let normalized = Math.max(0, Math.min(100, position));
    if (this._shouldInvertPosition()) {
      normalized = 100 - normalized;
    }

    return normalized;
  }

  _normalizePositionForDevice(position) {
    let normalized = Math.max(0, Math.min(100, position));
    if (this._shouldInvertPosition()) {
      normalized = 100 - normalized;
    }

    return normalized;
  }

  async onSettings({ newSettings, changedKeys }) {
    const previousInvert = this._shouldInvertPosition();
    const nextInvert = this._shouldInvertPosition(newSettings);

    if (changedKeys.includes('reverse_direction')) {
      await this._sendTuyaCommand(
        DP_DIRECTION,
        DP_TYPE_ENUM,
        Buffer.from([newSettings.reverse_direction ? DIRECTION_REVERSE : DIRECTION_FORWARD]),
      );
    }

    if (changedKeys.includes('calibration') && newSettings.calibration === true) {
      await this._sendTuyaCommand(DP_CALIBRATION, DP_TYPE_ENUM, Buffer.from([COMMAND_CALIBRATE]));
      try {
        await this.setSettings({ calibration: false });
      } catch (error) {
        this.error('Failed to reset calibration toggle', error);
      }
    }

    if (changedKeys.includes('advanced_params')) {
      this._parseAdvancedParams();
    }

    if (changedKeys.includes('state_override')) {
      await this._applyStateOverride(newSettings.state_override);
    }

    if (previousInvert !== nextInvert && this._lastPosition !== null) {
      const updatedPosition = 100 - this._lastPosition;
      await this._setLogicalPosition(updatedPosition);
    }
  }

  onDeleted() {
    if (this._keepAliveInterval) {
      this.homey.clearInterval(this._keepAliveInterval);
      this._keepAliveInterval = null;
    }
  }

};
