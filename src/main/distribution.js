'use strict';

function isMicrosoftStoreDistribution(runtimeProcess = process) {
  return runtimeProcess.platform === 'win32' && runtimeProcess.windowsStore === true;
}

module.exports = { isMicrosoftStoreDistribution };
