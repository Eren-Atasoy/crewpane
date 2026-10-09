'use strict';

const IDLE = 'IDLE';
const MOVE = 'MOVE';
const ARMED = 'ARMED';
const CLICK = 'CLICK';
const DRAG = 'DRAG';
const SCROLL = 'SCROLL';
const ZOOM = 'ZOOM';
const PARK = 'PARK';

const INF = Infinity;

function action(kind, x = 0.0, y = 0.0, { direction = '', clicks = 1, reason = '', dx = 0.0, dy = 0.0, scale = 0.0, delta = 0.0 } = {}) {
  // `scale`/`delta` yalnız kind='zoom' için anlamlı (HAND-G1); diğer aksiyonlarda
  // 0 kalır — parite testi kind/x/y/direction/clicks/reason'a bakar, şekil bozulmaz.
  return { kind, x, y, direction, clicks, reason, dx, dy, scale, delta };
}

module.exports = {
  IDLE,
  MOVE,
  ARMED,
  CLICK,
  DRAG,
  SCROLL,
  ZOOM,
  PARK,
  INF,
  action,
};
