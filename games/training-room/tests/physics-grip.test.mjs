// Grip alignment: a part with meta.grip (sword, axe, hammer...) turns into the hand's grip frame after a grab, through the
// hold joint over a short ramp, never by teleport; parts without a grip stay exactly where they were touched.
// Claude (Command), Oct 25 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.min.js';
import RAPIER from '../vendor/rapier/dist/rapier.mjs';
import { Room } from '../js/room.js';
import { SceneObjects } from '../js/world/objects.js';
import * as build from '../js/parts/build/index.js';
import { Interact } from '../js/play/interact.js';
import { PhysicsRoom, initPhysics } from '../js/physics/sync.js';
import { createPhysicsWorld } from '../js/dot3d/physics.js';
import { createBus } from '../js/dot3d/bus.js';
await initPhysics();
build.setPhysicsColliders(true);
const DEG=Math.PI/180;
const GRIP_Q=new THREE.Quaternion().setFromEuler(new THREE.Euler(-90*DEG,0,0)); // combat grip r [-90,0,0]
const record=(id,part,p,extra={})=>({id,part,p,ry:0,s:1,label:part,...extra});
const quat=o=>new THREE.Quaternion(o.x,o.y,o.z,o.w);
const vec=o=>new THREE.Vector3(o.x,o.y,o.z);
function setup(records) {
  const scene=new THREE.Scene(),room=new Room(),ops=[];
  const objects=new SceneObjects({scene,room,build});
  const send=op=>{ops.push(op);room.apply(op,{local:true});};
  const physics=new PhysicsRoom({objects,room,send});
  room.load({objects:Object.fromEntries(records.map(r=>[r.id,r])),order:records.map(r=>r.id),env:{time:'day'}});
  physics.sync();
  const interact=new Interact({objects,room,send,getUser:()=> 'local',metaOf:build.metaOfRecord});
  const tick=(n,hands,each)=>{for(let i=0;i<n;i++){objects.update(1/90,i/90);physics.setHands(hands);physics.update(1/90);each?.(i);}};
  return {scene,room,objects,physics,interact,ops,send,tick,dispose(){physics.dispose();objects.dispose();}};
}
// Sword lying flat: its handle (+Y) along +X, blade off to the side of the hand.
const FLAT=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),-90*DEG);
const flat={physicsPose:[FLAT.x,FLAT.y,FLAT.z,FLAT.w]};
// Error of the held body against the hand's grip frame: {angle rad, grip point to palm m}.
function gripError(core,hand,id,gripP) {
  const h=core.hands.get(hand),b=core.props.get(id).body;
  const want=quat(h.body.rotation()).multiply(GRIP_Q);
  const angle=quat(b.rotation()).angleTo(want);
  const point=vec(gripP).applyQuaternion(quat(b.rotation())).add(vec(b.translation()));
  return {angle,gap:point.distanceTo(vec(h.body.translation()))};
}

test('a sword picked up flat turns into the fist through the joint: handle in the palm, blade along the fist, no teleport',()=>{
  const s=setup([record('sword','sword',[.04,1.1,0],{data:flat})]);
  try {
    const hand={p:new THREE.Vector3(0,1.1,0),q:new THREE.Quaternion()};
    s.physics.setHands({right:hand});
    const before=quat(s.physics.entries.get('sword').body.rotation());
    assert.equal(s.interact.grab('right',{point:hand.p,quat:hand.q}),'sword');
    const core=s.physics.core;
    assert.ok(core.hands.get('right').joint,'held by a joint from the first step');
    assert.ok(core.aligning('right'),'a gripped part starts aligning');
    const start=gripError(core,'right','sword',{x:0,y:.14,z:0});
    assert.ok(start.angle>80*DEG,`starts far from the grip frame: ${(start.angle/DEG).toFixed(1)} deg`);
    let maxStep=0,maxOff=0,prev=before,atThree=null;
    s.tick(45,{right:hand},i=>{
      const b=s.physics.entries.get('sword').body,q=quat(b.rotation());
      maxStep=Math.max(maxStep,q.angleTo(prev));prev=q;
      maxOff=Math.max(maxOff,vec(core.hands.get('right').body.translation()).distanceTo(hand.p));
      if(i===2)atThree=gripError(core,'right','sword',{x:0,y:.14,z:0});
    });
    const end=gripError(core,'right','sword',{x:0,y:.14,z:0});
    assert.ok(end.angle<3*DEG,`blade lines up with the fist: ${(end.angle/DEG).toFixed(2)} deg off`);
    assert.ok(end.gap<.015,`handle grip point sits in the palm: ${end.gap.toFixed(4)} m`);
    assert.ok(!core.aligning('right'),'alignment finished within half a second');
    assert.ok(atThree.angle>20*DEG&&atThree.angle<start.angle,`turns gradually, not in one step: ${(atThree.angle/DEG).toFixed(1)} deg after 3 steps`);
    assert.ok(maxStep<15*DEG,`no single-step jump: biggest step ${(maxStep/DEG).toFixed(1)} deg`);
    assert.ok(maxOff<.12,`the hand is not dragged far by the realignment: ${maxOff.toFixed(3)} m`);
    const h=core.hands.get('right'),w=h.body.angvel();
    assert.ok(vec(h.body.translation()).distanceTo(hand.p)<.03,'hand back on the controller');
    assert.ok(quat(h.body.rotation()).angleTo(hand.q)<.15,'hand rotation back on the controller');
    assert.ok(Math.hypot(w.x,w.y,w.z)<.5,`held sword does not keep the hand spinning: ${Math.hypot(w.x,w.y,w.z).toFixed(3)} rad/s`);
    assert.ok(s.physics.entries.get('sword').body.isDynamic(),'the sword stays dynamic while held');
    assert.equal(s.room.get('sword').attach?.grip,'snap');
  }finally{s.dispose();}
});

test('a part without a grip (crate) is still held exactly where it was touched',()=>{
  const s=setup([record('crate','crate',[.5,0,0])]);
  try {
    const hand={p:new THREE.Vector3(0,.95,0),q:new THREE.Quaternion().setFromEuler(new THREE.Euler(.4,.2,0))};
    s.physics.setHands({right:hand});
    assert.equal(build.metaOfRecord(s.room.get('crate')).grip,undefined,'the crate has no grip in its meta');
    assert.equal(s.interact.grab('right',{point:hand.p,quat:hand.q}),'crate');
    const core=s.physics.core,b=s.physics.entries.get('crate').body,h=core.hands.get('right');
    assert.ok(!core.aligning('right'),'no alignment without meta.grip');
    const rel0=quat(h.body.rotation()).invert().multiply(quat(b.rotation()));
    const off0=vec(b.translation()).sub(vec(h.body.translation())).applyQuaternion(quat(h.body.rotation()).invert());
    s.tick(90,{right:hand});
    const rel1=quat(h.body.rotation()).invert().multiply(quat(b.rotation()));
    const off1=vec(b.translation()).sub(vec(h.body.translation())).applyQuaternion(quat(h.body.rotation()).invert());
    assert.ok(rel0.angleTo(rel1)<2*DEG,`relative rotation kept: ${(rel0.angleTo(rel1)/DEG).toFixed(2)} deg`);
    assert.ok(off0.distanceTo(off1)<.01,`relative offset kept: ${off0.distanceTo(off1).toFixed(4)} m`);
  }finally{s.dispose();}
});

test('a distance-pulled sword aligns to the grip when it arrives; release mid-alignment leaves nothing behind',()=>{
  const core=createPhysicsWorld(RAPIER,createBus());
  try {
    core.add('__floor',{p:{x:0,y:-.1,z:0},fixed:true,shapes:[{p:{x:0,y:0,z:0},size:{x:40,y:.2,z:40},material:'stone'}]});
    const shapes=[{p:{x:0,y:.52,z:0},size:{x:.03,y:1.05,z:.03},material:'metal'},{p:{x:0,y:.24,z:0},size:{x:.24,y:.026,z:.03},material:'metal'}];
    core.add('sword',{p:{x:0,y:.03,z:-2.5},q:{x:FLAT.x,y:FLAT.y,z:FLAT.z,w:FLAT.w},shapes});
    const pose={p:new THREE.Vector3(0,1.2,0),q:new THREE.Quaternion()};
    for(let i=0;i<5;i++){core.targetHand('right',pose);core.advance(1/90);}
    const grip={anchor:{x:0,y:.14,z:0},q:{x:GRIP_Q.x,y:GRIP_Q.y,z:GRIP_Q.z,w:GRIP_Q.w}};
    assert.equal(core.pull('right','sword',{x:0,y:.03,z:-2.5},grip),true);
    let arrived=-1;
    for(let i=0;i<360&&arrived<0;i++){core.targetHand('right',pose);core.advance(1/90);if(core.hands.get('right').joint)arrived=i;}
    assert.ok(arrived>=0,'the pulled sword arrives and attaches');
    assert.ok(core.aligning('right'),'alignment starts on arrival');
    for(let i=0;i<60;i++){core.targetHand('right',pose);core.advance(1/90);}
    const end=gripError(core,'right','sword',{x:0,y:.14,z:0});
    assert.ok(end.angle<3*DEG,`arrived sword lines up with the fist: ${(end.angle/DEG).toFixed(2)} deg`);
    assert.ok(end.gap<.015,`arrived sword handle in the palm: ${end.gap.toFixed(4)} m`);
    // Second grab: release in the middle of the ramp.
    assert.equal(core.release('right'),'sword');
    const b=core.props.get('sword').body;b.setTranslation({x:.04,y:1.2,z:0},true);b.setRotation({x:FLAT.x,y:FLAT.y,z:FLAT.z,w:FLAT.w},true);b.setLinvel({x:0,y:0,z:0},true);b.setAngvel({x:0,y:0,z:0},true);
    for(let i=0;i<20;i++){core.targetHand('right',pose);core.advance(1/90);}
    assert.equal(core.grab('right','sword',grip),true);
    for(let i=0;i<4;i++){core.targetHand('right',pose);core.advance(1/90);}
    assert.ok(core.aligning('right'));
    assert.equal(core.release('right'),'sword');
    assert.ok(!core.aligning('right')&&!core.hands.get('right').joint&&core.hands.get('right').id===null);
    for(let i=0;i<30;i++){core.targetHand('right',pose);core.advance(1/90);}
    assert.ok(b.isDynamic()&&Number.isFinite(b.translation().y),'the dropped sword keeps simulating');
  }finally{core.dispose();}
});
