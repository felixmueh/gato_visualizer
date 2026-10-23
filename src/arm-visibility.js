// Hiding the solid arm uses layers so ghost clones retain their visible
// hierarchy. Their renderer assigns its own layers after cloning. Zero masks
// also exclude the hidden arm from picking in the shared scene.
export function createArmVisibility(robot, armRoot = 'arm_right_1_joint') {
  const root = robot.joints?.[armRoot], masks = new Map();
  let visible = true;
  return {
    setVisible(value) {
      visible = Boolean(value);
      if (visible) {
        for (const [object, mask] of masks) object.layers.mask = mask;
        masks.clear();
      } else root?.traverse(object => {
        if (!masks.has(object)) masks.set(object, object.layers.mask);
        object.layers.mask = 0;
      });
    },
    get visible() { return visible; },
  };
}
