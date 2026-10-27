// Rigs: parts that stand on a post or a stand and should rock when struck instead of standing rigid or toppling
// whole. A rig splits the built part at one pivot: everything below the pivot plane is the base (fixed, planted),
// everything above is the swing (a dynamic body hung on the base by the dot3d mount: ball joint + spring, see
// js/dot3d/physics.js mount). A hit knocks the swing back, it rocks and settles; past breakAt of tilt the joint
// gives and the top falls off as a free prop. Owner, Oct 23 2026 (Codex transmitter): "object reaction ... The world
// should respond as the world would really respond." Claude (Command), Oct 26 2026.
import * as THREE from '../../vendor/three.module.min.js';

const DEG=Math.PI/180;
// Built-in parts with a rig. pivot: part-local point (unscaled) where the swing hangs; hz: how fast it rocks; settle:
// damping ratio (0.25 = a few visible rocks); breakAt: tilt in radians that breaks it off (null = never).
export const RIGS = {
  // Straw body and crossbar hang on the post top (post spans y 0.05-1.05); the pedestal and post stay planted.
  'training dummy': { pivot: [0, 1.0, 0], hz: .75, settle: .22, breakAt: 60*DEG },
};
// The rig for a record's part: an explicit meta.rig (an AI or owner blueprint can declare one) or the built-in table.
export function rigFor(part, meta=null) {
  const r=meta?.rig ?? RIGS[String(part||'').toLowerCase()] ?? null;
  if(!r||!Array.isArray(r.pivot)||r.pivot.length!==3||!r.pivot.every(Number.isFinite)) return null;
  return { pivot:[+r.pivot[0],+r.pivot[1],+r.pivot[2]], hz:+r.hz>0?+r.hz:.9, settle:+r.settle>=0?+r.settle:.25,
    breakAt:+r.breakAt>0?+r.breakAt:null };
}
const above=(y,rig)=>y>=rig.pivot[1];
// Split collider shapes (part-local, from colliders.js) at the pivot plane by their centres.
export function splitShapes(shapes, rig) {
  const base=[],swing=[];
  for(const s of shapes||[]) (above(s.p.y,rig)?swing:base).push(s);
  return { base, swing };
}
// Split the built meshes: those above the pivot move (world pose kept) into a 'swing' group whose origin is the pivot,
// so posing that group from the swing body is all the render side has to do. Call before any static merge; the swing
// meshes are marked keep so a later merge of the whole part leaves them in their group. Returns the swing group.
export function splitMeshes(inner, rig) {
  inner.updateWorldMatrix(true,true);
  const inv=new THREE.Matrix4().copy(inner.matrixWorld).invert();
  const swing=new THREE.Group();
  swing.name='rig:swing';
  swing.position.fromArray(rig.pivot);
  inner.add(swing);
  swing.updateMatrixWorld(true);
  const moving=[];
  const m=new THREE.Matrix4(),c=new THREE.Vector3();
  inner.traverse(mesh=>{
    if(!mesh.isMesh||mesh.userData.phaseHelper||!mesh.geometry) return;
    const g=mesh.geometry;
    if(!g.boundingBox)g.computeBoundingBox();
    if(!g.boundingBox||g.boundingBox.isEmpty()) return;
    m.multiplyMatrices(inv,mesh.matrixWorld);
    g.boundingBox.getCenter(c).applyMatrix4(m);
    if(above(c.y,rig)) moving.push(mesh);
  });
  for(const mesh of moving) swing.attach(mesh);
  return swing;
}
// Everything the physics side needs from a built part, or null when the part has no rig or nothing above the pivot.
export function buildRig(inner, shapes, rig) {
  if(!rig||!shapes?.length) return null;
  const split=splitShapes(shapes,rig);
  if(!split.swing.length) return null;
  const swing=splitMeshes(inner,rig);
  return { pivot:{x:rig.pivot[0],y:rig.pivot[1],z:rig.pivot[2]}, hz:rig.hz, settle:rig.settle, breakAt:rig.breakAt,
    shapes:split, swing };
}
// Mark a group's meshes so kit.mergeStatic of an enclosing root leaves them alone (merge the group itself first).
export function keepMeshes(group) { group.traverse(o=>{ if(o.isMesh) o.userData.keep=true; }); }
