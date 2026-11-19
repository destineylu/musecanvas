// 低多边形关节人偶。人偶面朝 +z，自身左侧是 +x。
// 关节姿态是相对父关节的 XYZ 欧拉角（度）。零姿态为自然垂臂站立；
// 肩、髋绕负 X 向前抬起，肘绕负 X 向前弯，膝绕正 X 向后弯。

export const JOINTS = [
  { id: 'hips', label: '胯部', group: '躯干' },
  { id: 'spine', label: '腰背', group: '躯干' },
  { id: 'neck', label: '脖子', group: '头颈' },
  { id: 'head', label: '头', group: '头颈' },
  { id: 'leftShoulder', label: '左肩', group: '左臂' },
  { id: 'leftElbow', label: '左肘', group: '左臂' },
  { id: 'leftWrist', label: '左腕', group: '左臂' },
  { id: 'rightShoulder', label: '右肩', group: '右臂' },
  { id: 'rightElbow', label: '右肘', group: '右臂' },
  { id: 'rightWrist', label: '右腕', group: '右臂' },
  { id: 'leftHip', label: '左髋', group: '左腿' },
  { id: 'leftKnee', label: '左膝', group: '左腿' },
  { id: 'leftAnkle', label: '左踝', group: '左腿' },
  { id: 'rightHip', label: '右髋', group: '右腿' },
  { id: 'rightKnee', label: '右膝', group: '右腿' },
  { id: 'rightAnkle', label: '右踝', group: '右腿' },
];

export const POSES = [
  { id: 'stand', label: '站立', pose: {} },
  { id: 'walk', label: '行走', pose: { rightShoulder: [-25, 0, 0], leftShoulder: [25, 0, 0], leftElbow: [-15, 0, 0], rightElbow: [-20, 0, 0], leftHip: [-25, 0, 0], rightHip: [18, 0, 0], rightKnee: [28, 0, 0], leftKnee: [6, 0, 0] } },
  { id: 'run', label: '奔跑', pose: { spine: [12, 0, 0], rightShoulder: [-60, 0, 0], leftShoulder: [50, 0, 0], leftElbow: [-85, 0, 0], rightElbow: [-85, 0, 0], leftHip: [-60, 0, 0], leftKnee: [70, 0, 0], rightHip: [28, 0, 0], rightKnee: [75, 0, 0], hipsY: [-0.06, 0, 0] } },
  { id: 'walk2', label: '行走·换腿', pose: { leftShoulder: [-25, 0, 0], rightShoulder: [25, 0, 0], rightElbow: [-15, 0, 0], leftElbow: [-20, 0, 0], rightHip: [-25, 0, 0], leftHip: [18, 0, 0], leftKnee: [28, 0, 0], rightKnee: [6, 0, 0] } },
  { id: 'run2', label: '奔跑·换腿', pose: { spine: [12, 0, 0], leftShoulder: [-60, 0, 0], rightShoulder: [50, 0, 0], leftElbow: [-85, 0, 0], rightElbow: [-85, 0, 0], rightHip: [-60, 0, 0], rightKnee: [70, 0, 0], leftHip: [28, 0, 0], leftKnee: [75, 0, 0], hipsY: [-0.06, 0, 0] } },
  { id: 'sit', label: '坐下', pose: { leftHip: [-88, 0, 4], rightHip: [-88, 0, -4], leftKnee: [88, 0, 0], rightKnee: [88, 0, 0], leftShoulder: [-20, 0, 0], rightShoulder: [-20, 0, 0], leftElbow: [-45, 0, 0], rightElbow: [-45, 0, 0], hipsY: [-0.46, 0, 0] } },
  { id: 'squat', label: '下蹲', pose: { spine: [25, 0, 0], leftHip: [-110, 0, 8], rightHip: [-110, 0, -8], leftKnee: [130, 0, 0], rightKnee: [130, 0, 0], leftAnkle: [-20, 0, 0], rightAnkle: [-20, 0, 0], leftShoulder: [-60, 0, 0], rightShoulder: [-60, 0, 0], hipsY: [-0.5, 0, 0] } },
  { id: 'wave', label: '挥手', pose: { rightShoulder: [0, 0, -150], rightElbow: [0, 0, -25], leftShoulder: [0, 0, 6], head: [0, -10, 0] } },
  { id: 'point', label: '指向', pose: { rightShoulder: [-88, 0, 0], head: [0, -8, 0], leftShoulder: [0, 0, 5] } },
  { id: 'tpose', label: '张开双臂', pose: { leftShoulder: [0, 0, 88], rightShoulder: [0, 0, -88] } },
  { id: 'cheer', label: '举双手', pose: { leftShoulder: [0, 0, 160], rightShoulder: [0, 0, -160], head: [-12, 0, 0] } },
  { id: 'think', label: '托腮', pose: { head: [10, 0, 0], rightShoulder: [-35, 0, 10], rightElbow: [-140, 0, 0], leftShoulder: [-30, 0, -20], leftElbow: [-95, 0, 0] } },
];

const DEG = Math.PI / 180;

/** 构建人偶，返回 { root, joints }，joints[id] 为可旋转的 Group。 */
export function buildMannequin(THREE, color = '#d9d4cc') {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.02 });
  const jointMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.78), roughness: 0.5 });
  const root = new THREE.Group();
  const joints = {};
  const group = (id, parent, x, y, z) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.name = id;
    parent.add(g);
    joints[id] = g;
    return g;
  };
  const part = (parent, joint, mesh, y) => {
    mesh.position.y = y;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.joint = joint;
    parent.add(mesh);
    return mesh;
  };
  const capsule = (r, len) => new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 14), mat);
  const ball = (r) => new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), jointMat);

  const hips = group('hips', root, 0, 0.94, 0);
  part(hips, 'hips', new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.18), mat), 0).geometry.translate(0, 0, 0);
  const spine = group('spine', hips, 0, 0.07, 0);
  const torso = part(spine, 'spine', capsule(0.13, 0.26), 0.2);
  torso.scale.set(1.1, 1, 0.7);
  const neck = group('neck', spine, 0, 0.47, 0);
  part(neck, 'neck', capsule(0.04, 0.05), 0.03);
  const head = group('head', neck, 0, 0.09, 0);
  part(head, 'head', new THREE.Mesh(new THREE.SphereGeometry(0.105, 24, 18), mat), 0.1).scale.set(0.9, 1.08, 1);
  const nose = part(head, 'head', new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.05, 10), jointMat), 0.1);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 0.1;

  for (const side of ['left', 'right']) {
    const sx = side === 'left' ? 1 : -1;
    const shoulder = group(`${side}Shoulder`, spine, sx * 0.19, 0.41, 0);
    part(shoulder, `${side}Shoulder`, ball(0.05), 0);
    part(shoulder, `${side}Shoulder`, capsule(0.045, 0.2), -0.15);
    const elbow = group(`${side}Elbow`, shoulder, 0, -0.3, 0);
    part(elbow, `${side}Elbow`, ball(0.04), 0);
    part(elbow, `${side}Elbow`, capsule(0.038, 0.18), -0.13);
    const wrist = group(`${side}Wrist`, elbow, 0, -0.26, 0);
    const hand = part(wrist, `${side}Wrist`, new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.07), jointMat), -0.06);
    hand.castShadow = true;

    const hip = group(`${side}Hip`, hips, sx * 0.1, -0.05, 0);
    part(hip, `${side}Hip`, ball(0.06), 0);
    part(hip, `${side}Hip`, capsule(0.065, 0.28), -0.21);
    const knee = group(`${side}Knee`, hip, 0, -0.42, 0);
    part(knee, `${side}Knee`, ball(0.05), 0);
    part(knee, `${side}Knee`, capsule(0.05, 0.3), -0.21);
    const ankle = group(`${side}Ankle`, knee, 0, -0.42, 0);
    const foot = part(ankle, `${side}Ankle`, new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.22), jointMat), -0.04);
    foot.position.z = 0.05;
  }
  root.userData.baseHipsY = hips.position.y;
  return { root, joints, materials: [mat, jointMat] };
}

export function applyPose(rig, pose = {}) {
  for (const { id } of JOINTS) {
    const r = pose[id] || [0, 0, 0];
    rig.joints[id].rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG);
  }
  rig.joints.hips.position.y = rig.root.userData.baseHipsY + (pose.hipsY?.[0] || 0);
}

export function setMannequinColor(rig, color, THREE) {
  rig.materials[0].color.set(color);
  rig.materials[1].color.copy(new THREE.Color(color).multiplyScalar(0.78));
}
