import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OnlinePill } from '../../public/js/ui/components.js';

function value(node) {
  return node.props.children.find((child) => child?.props?.class === 'online-pill__value').props.children;
}

test('online badge distinguishes a valid zero from unknown and invalid counts', () => {
  for (const count of [0, 1, 2345]) {
    const node = OnlinePill({ count });
    assert.equal(value(node), count);
    assert.equal(node.props['aria-label'], `当前在线 ${count} 人`);
    assert.equal(node.props.role, 'status');
    assert.equal(node.props['aria-live'], 'polite');
    assert.doesNotMatch(node.props.class, /unknown/);
  }
  for (const count of [null, undefined, -1, 0.5, '3', Infinity, NaN]) {
    const node = OnlinePill({ count });
    assert.equal(value(node), '--');
    assert.match(node.props.class, /unknown/);
    assert.equal(node.props['aria-label'], '在线人数暂未获取');
  }
});
