// P3 rig: a training dummy on its post is two bodies (planted base, swing hung on a ball joint with a spring,
// js/dot3d/physics.js mount + js/physics/rig.js). A sword hit knocks the swing back, it rocks and settles, the hit
// marks it (scuff + dust on the bus) and pulses the hand; past 60 degrees the joint gives and the top falls off as a
// free prop you can pick up. Owner, Oct 23 2026 (Codex transmitter): "object reaction ... The world should respond as
// the world would really respond." Claude (Command), Oct 26 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.min.js';
import { Room } from '../js/room.js';
import { SceneObjects } from '../js/world/objects.js';
import * as build from '../js/parts/build/index.js';
import { Interact } from '../js/play/interact.js';
import { PhysicsRoom, initPhysics } from '../js/physics/sync.js';
import { createHitEffects } from '../js/physics/hits.js';
import { RIGS, rigFor, splitShapes } from '../js/physics/rig.js';
import { createDecals } from '../js/dot3d/decals.js';
import { createParticles } from '../js/dot3d/particles.js';
await initPhysics();
build.setPhysicsColliders(true);
const DEG=Math.PI/180;
const record=(id,part,p,extra={})=>({id,part,p,ry:0,s:1,label:part,...extra});
const FLAT=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),-90*DEG);
const flat={physicsPose:[FLAT.x,FLAT.y,FLAT.z,FLAT.w]};
const vec=o=>new THREE.Vector3(o.x,o.y,o.z),quat=o=>new THREE.Quaternion(o.x,o.y,o.z,o.w);
function setup(records) {
  const scene=new THREE.Scene(),room=new Room(),ops=[];
  const objects=new SceneObjects({scene,room,build});
  const send=op=>{ops.push(op);room.apply(op,{local:true});};
  const physics=new PhysicsRoom({objects,room,send});
  room.load({objects:Object.fromEntries(records.map(r=>[r.id,r])),order:records.map(r=>r.id),env:{time:'day'}});
  physics.sync();
  const interact=new Interact({objects,room,send,getUser:()=> 'local',metaOf:build.metaOfRecord});
  const contacts=[],hits=[],breaks=[],pulses=[];
  physics.bus.on('contact',e=>contacts.push(e));physics.bus.on('hit',e=>hits.push(e));physics.bus.on('break',e=>breaks.push(e));
  const decals=createDecals(THREE,{scene,bus:physics.bus,maxDecals:64});
  const particles=createParticles(THREE,{scene,bus:physics.bus,maxParticles:256});
  const fx=createHitEffects({bus:physics.bus,core:physics.core,sfx:null,haptic:(hand,intensity,ms)=>{pulses.push({hand,intensity,ms});return true;}});
  const tick=(n,hands={})=>{for(let i=0;i<n;i++){objects.update(1/90,i/90);physics.setHands(hands);physics.update(1/90);particles.update(1/90);decals.update(1/90);}};
  return {scene,room,objects,physics,interact,tick,contacts,hits,breaks,pulses,decals,particles,ops,dispose(){fx.dispose();physics.dispose();objects.dispose();}};
}
const lean=s=>s.physics.core.lean('dummy');

test('rig table and split: the training dummy splits at its post top; a part without a rig has none; a blueprint can declare one',()=>{
  const rig=rigFor('training dummy',build.metaOfRecord(record('d','training dummy',[0,0,0])));
  assert.ok(rig&&rig.pivot[1]===1&&rig.breakAt>0&&rig.hz>0,JSON.stringify(rig));
  assert.equal(rigFor('crate',build.metaOfRecord(record('c','crate',[0,0,0]))),null);
  assert.equal(rigFor('training dummy',{rig:{pivot:[0,'x',0]}}),null,'a broken meta.rig is ignored');
  const bp={name:'sign on a pole',size:[.6,2,.1],rig:{pivot:[0,1.6,0],hz:1.2,breakAt:1},parts:[{shape:'box',p:[0,.8,0],s:[.06,1.6,.06],mat:'wood'},{shape:'box',p:[0,1.8,0],s:[.6,.4,.04],mat:'wood'}]};
  const meta=build.metaOfRecord(record('sign','sign on a pole',[0,0,0],{data:{blueprint:bp}}));
  assert.deepEqual(rigFor('sign on a pole',meta),{pivot:[0,1.6,0],hz:1.2,settle:.25,breakAt:1});
  const {base,swing}=splitShapes([{p:{x:0,y:.5,z:0}},{p:{x:0,y:1.6,z:0}},{p:{x:0,y:1.2,z:0}}],rig);
  assert.deepEqual([base.length,swing.length],[1,2]);
  assert.ok(Object.keys(RIGS).includes('training dummy'));
  // Built object: swing meshes in their own group at the pivot, base and swing colliders on each side of the plane.
  const w=build.buildObject(record('d','training dummy',[0,0,0]));
  const pr=w.userData.physicsRig;
  assert.ok(pr&&pr.swing.parent===w.userData.inner&&pr.swing.position.y===1,'swing group at the pivot');
  assert.ok(pr.shapes.base.length>=2&&pr.shapes.base.every(s=>s.p.y<1)&&pr.shapes.swing.length>=8&&pr.shapes.swing.every(s=>s.p.y>=1),'colliders split at the plane');
  assert.ok(pr.shapes.swing.some(s=>s.material==='fabric')&&pr.shapes.base.every(s=>s.material==='wood'),'straw above, wooden post below');
  let swingMeshes=0,baseMeshes=0;pr.swing.traverse(o=>{if(o.isMesh)swingMeshes++;});w.userData.inner.traverse(o=>{if(o.isMesh&&!pr.swing.getObjectById(o.id))baseMeshes++;});
  assert.ok(swingMeshes>=2&&swingMeshes<=8&&baseMeshes>=1&&baseMeshes<=3,`merged per side: swing ${swingMeshes}, base ${baseMeshes}`);
  const crate=build.buildObject(record('c','crate',[0,0,0]));
  assert.equal(crate.userData.physicsRig,null);
});

test('a dummy stands: planted base, swing mounted, no self-contacts, upright and asleep after a few seconds; not a thing to grab',()=>{
  const s=setup([record('dummy','training dummy',[0,0,-1.3])]);
  try {
    const core=s.physics.core,e=s.physics.entries.get('dummy');
    assert.ok(e?.rig&&core.props.has('dummy#base')&&core.props.get('dummy#base').fixed&&!core.props.get('dummy').fixed,'two bodies, base fixed');
    assert.ok(core.mounted('dummy')&&s.physics.rig('dummy').mounted,'mounted');
    const m=core.mounts.get('dummy');
    assert.ok(m.k>m.c&&m.k>100&&m.breakAt===RIGS['training dummy'].breakAt,`spring ${m.k.toFixed(0)} N m/rad, damping ${m.c.toFixed(1)}`);
    assert.ok(e.body.mass()>10&&e.body.mass()<80,`a straw top of ${e.body.mass().toFixed(1)} kg`);
    let max=0;for(let i=0;i<360;i++){s.tick(1);max=Math.max(max,lean(s));}
    assert.ok(max<1*DEG,`stands upright: max lean ${(max/DEG).toFixed(2)} deg`);
    assert.equal(s.contacts.length,0,'the straw overlapping the post top is not a contact (joint contacts off)');
    assert.ok(e.body.isSleeping(),'asleep at rest');
    assert.equal(s.physics.canGrab('dummy'),false);assert.equal(s.physics.has('dummy'),true);
    const g=e.rig.swing;
    assert.ok(g.position.distanceTo(new THREE.Vector3(0,1,0))<.005&&Math.abs(g.quaternion.w)>.9999&&Math.abs(g.scale.x-1)<1e-6,'swing group drawn at its built pose');
    assert.equal(s.ops.filter(o=>o.t==='set'&&o.patch&&'p' in o.patch).length,0,'no pose patches for a planted rig');
  } finally { s.dispose(); }
});

test('a knock rocks it and it settles; a harder knock higher up leans it more; a brutal one breaks it off and the top lands on the floor, free to pick up',()=>{
  const s=setup([record('dummy','training dummy',[0,0,-1.3])]);
  try {
    const e=s.physics.entries.get('dummy'),b=e.body;
    s.tick(90);
    const at=(y,dz)=>{const p=vec(b.translation());p.y=y;p.z+=dz;return p;};
    b.applyImpulseAtPoint({x:0,y:0,z:-20},at(1.25,.2),true); // a sword swing's worth on the chest, from the front
    let peak=0,peakT=0,settled=null;
    for(let i=0;i<360;i++){s.tick(1);const l=lean(s);if(l>peak){peak=l;peakT=i/90;}if(settled===null&&i/90>peakT+.4&&l<1.2*DEG)settled=i/90;}
    assert.ok(peak>6*DEG&&peak<20*DEG,`chest knock rocks it ${(peak/DEG).toFixed(1)} deg`);
    assert.ok(peakT<.5&&settled!==null&&settled<3,`peak at ${peakT.toFixed(2)} s, settled at ${settled} s`);
    assert.ok(lean(s)<1.2*DEG,`back upright: ${(lean(s)/DEG).toFixed(2)} deg`);
    const g=e.rig.swing;assert.ok(Math.abs(new THREE.Vector3(0,1,0).applyQuaternion(g.quaternion).angleTo(new THREE.Vector3(0,1,0))-lean(s))<.02,'the drawn swing group leans with the body');
    assert.equal(s.breaks.length,0);
    b.applyImpulseAtPoint({x:0,y:0,z:-25},at(1.65,.13),true); // the head: longer lever, bigger lean
    let peak2=0;for(let i=0;i<180;i++){s.tick(1);peak2=Math.max(peak2,lean(s));}
    assert.ok(peak2>peak*1.8&&peak2<60*DEG,`head knock leans it ${(peak2/DEG).toFixed(1)} deg, not off`);
    assert.equal(s.breaks.length,0);
    s.tick(270);
    b.applyImpulseAtPoint({x:0,y:0,z:-60},at(1.65,.13),true);
    let brokeAt=null;for(let i=0;i<360;i++){s.tick(1);if(brokeAt===null&&s.breaks.length)brokeAt=i/90;}
    assert.ok(brokeAt!==null&&brokeAt<1,`broke off at ${brokeAt} s`);
    assert.deepEqual(Object.keys(s.breaks[0]).sort(),['id','lean','onId','time']);
    assert.ok(s.breaks[0].id==='dummy'&&s.breaks[0].onId==='dummy#base'&&s.breaks[0].lean>=60*DEG);
    assert.ok(!s.physics.core.mounted('dummy')&&s.physics.rig('dummy').mounted===false&&s.physics.core.props.has('dummy#base'),'joint gone, post still planted');
    const p=vec(b.translation());
    assert.ok(p.y<.6&&p.distanceTo(new THREE.Vector3(0,1,-1.3))>.5,`the top fell to the floor: ${p.toArray().map(v=>v.toFixed(2))}`);
    assert.ok(s.contacts.some(c=>c.impulse>5),'and landed with a thud on the bus');
    assert.ok(g.position.y<.6,'drawn where it fell');
    assert.equal(s.physics.canGrab('dummy'),true,'a fallen top is a prop you can pick up');
    const hand={p:p.clone().add(new THREE.Vector3(0,.15,0)),q:new THREE.Quaternion()};
    s.physics.setHands({right:hand});
    assert.equal(s.interact.grab('right',{point:hand.p,quat:hand.q}),'dummy','grabbed');
    // 35 kg of straw top is more than one hand lifts (350 N cap): it drags along the floor toward the hand.
    s.tick(120,{right:{p:hand.p.clone().add(new THREE.Vector3(.8,0,0)),q:new THREE.Quaternion()}});
    assert.ok(vec(b.translation()).x-p.x>.25,`dragged ${(vec(b.translation()).x-p.x).toFixed(2)} m toward the hand`);
    assert.equal(s.ops.filter(o=>o.t==='set'&&o.patch&&'p' in o.patch).length,0,'the record (the post) never moves');
  } finally { s.dispose(); }
});

test('the real path: a held sword swung into the dummy marks it, pulses the hand and knocks it back; it settles once the sword is pulled away',()=>{
  const s=setup([record('sword','sword',[.04,1.1,0],{data:flat}),record('dummy','training dummy',[0,0,-1.25])]);
  try {
    const hand={p:new THREE.Vector3(0,1.1,0),q:new THREE.Quaternion()};
    s.physics.setHands({right:hand});
    assert.equal(s.interact.grab('right',{point:hand.p,quat:hand.q}),'sword');
    s.tick(120,{right:hand});
    const raised={p:new THREE.Vector3(0,1.3,-.1),q:new THREE.Quaternion()};
    s.tick(90,{right:raised});
    assert.equal(s.hits.length,0);assert.ok(lean(s)<1*DEG);
    const d0=s.decals.count(),sp0=s.particles.stats().spawnedTotal;
    let peak=0,hitAt=null;
    const swing={p:new THREE.Vector3(0,1.3,-.9),q:new THREE.Quaternion()};
    for(let i=0;i<90;i++){s.tick(1,{right:swing});if(hitAt===null&&s.hits.length)hitAt=i;peak=Math.max(peak,lean(s));}
    assert.ok(hitAt!==null&&hitAt<20,'the blade lands within 20 steps');
    const h=s.hits[0];
    assert.equal(h.hand,'right');assert.equal(h.id,'sword');
    assert.ok(h.impulse>3,`a real hit: ${h.impulse.toFixed(2)} N*s`);
    assert.ok(h.materials.includes('soft'),'struck straw: '+h.materials);
    assert.ok(h.point.y>1.05&&h.point.y<1.5&&h.point.z<-.95&&h.point.z>-1.3,'contact on the dummy body: '+JSON.stringify(h.point));
    assert.ok(s.pulses.length>=1&&s.pulses[0].hand==='right','the controller pulsed');
    assert.ok(peak>8*DEG,`knocked back ${(peak/DEG).toFixed(1)} deg`);
    assert.ok(s.decals.count()>d0,'a mark on the straw');
    const pk=s.particles.stats();assert.ok(pk.spawnedTotal>sp0&&pk.byKind.dust>0,'dust from the straw: '+JSON.stringify(pk.byKind));
    assert.equal(s.breaks.length,0,'a sword swing does not tear it off');
    s.tick(90,{right:raised});
    s.tick(360,{right:raised});
    assert.ok(lean(s)<2*DEG,`settled after the sword is withdrawn: ${(lean(s)/DEG).toFixed(2)} deg`);
    assert.ok(s.physics.core.mounted('dummy'));
  } finally { s.dispose(); }
});

test('record moves re-plant the rig; a scaled dummy scales its pivot; delete removes both bodies and the mount',()=>{
  const s=setup([record('dummy','training dummy',[1,0,-2],{ry:1,s:1.5})]);
  try {
    const core=s.physics.core;
    const swing=vec(core.props.get('dummy').body.translation()),base=vec(core.props.get('dummy#base').body.translation());
    assert.ok(swing.distanceTo(new THREE.Vector3(1,1.5,-2))<1e-6&&base.distanceTo(new THREE.Vector3(1,0,-2))<1e-6,'pivot at 1.5 x the post height');
    assert.ok(core.props.get('dummy').body.mass()>80,'a bigger dummy weighs more');
    s.tick(90);
    s.room.apply({t:'set',id:'dummy',patch:{p:[-1,0,-3]}},{local:true});
    s.tick(2);
    assert.ok(vec(core.props.get('dummy#base').body.translation()).distanceTo(new THREE.Vector3(-1,0,-3))<1e-6,'base re-planted at the new record pose');
    assert.ok(vec(core.props.get('dummy').body.translation()).distanceTo(new THREE.Vector3(-1,1.5,-3))<1e-6&&core.mounted('dummy'),'swing re-hung there');
    assert.deepEqual(s.objects.entries.get('dummy').wrapper.position.toArray(),[-1,0,-3]);
    s.room.apply({t:'set',id:'dummy',patch:{ry:2}},{local:true});
    s.tick(2);
    const q=quat(core.props.get('dummy').body.rotation());
    assert.ok(q.angleTo(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),2))<1*DEG,'turned with the record (within its resting lean)');
    s.room.apply({t:'del',ids:['dummy']},{local:true});
    s.tick(120);
    assert.equal(core.props.size,1,'only the floor is left');
    assert.equal(core.mounts.size,0);assert.equal(s.physics.entries.size,0);
  } finally { s.dispose(); }
});

test('the core mount on its own: a plain box hung on a fixed post rocks at about its hz and settles; unmount frees it; removing the base removes the mount',()=>{
  const s=setup([]);
  try {
    const core=s.physics.core;
    core.add('post',{p:{x:0,y:0,z:0},fixed:true,shapes:[{p:{x:0,y:.5,z:0},size:{x:.1,y:1,z:.1},material:'wood'}]});
    core.add('box',{p:{x:0,y:1,z:0},fixed:false,shapes:[{p:{x:0,y:.3,z:0},size:{x:.3,y:.6,z:.3},material:'wood'}]});
    assert.equal(core.mount('box','post',{anchor:{x:0,y:1,z:0},hz:1,settle:.1}),true);
    assert.equal(core.mount('post','box',{anchor:{x:0,y:1,z:0}}),false,'a fixed body cannot be hung');
    assert.equal(core.mount('box','nope',{anchor:{x:0,y:1,z:0}}),false);
    const b=core.props.get('box').body;
    s.tick(45);
    b.applyImpulseAtPoint({x:4,y:0,z:0},{x:0,y:1.5,z:0},true);
    // Count zero crossings of the lean direction over 3 s: about hz x 3 x 2.
    let prev=0,crossings=0,peak=0;
    for(let i=0;i<270;i++){s.tick(1);const x=vec(b.worldCom()).x;if(prev!==0&&Math.sign(x)!==Math.sign(prev))crossings++;prev=x;peak=Math.max(peak,core.lean('box'));}
    assert.ok(peak>2*DEG,`it swung ${(peak/DEG).toFixed(1)} deg`);
    assert.ok(crossings>=3&&crossings<=9,`rocks at about 1 Hz: ${crossings} crossings in 3 s`);
    s.tick(270);
    assert.ok(core.lean('box')<1*DEG,'settled');
    assert.equal(core.unmount('box'),true);assert.equal(core.unmount('box'),false);
    assert.equal(core.lean('box'),null);
    assert.equal(s.breaks.length,0,'an unmount by hand is not a break');
    assert.equal(core.mount('box','post',{anchor:{x:0,y:1,z:0}}),true);
    core.remove('post');
    assert.equal(core.mounts.size,0,'the mount went with its base');
    assert.ok(core.props.has('box'));
    s.tick(90);
    assert.ok(vec(b.translation()).y<1,'and the box fell');
  } finally { s.dispose(); }
});
