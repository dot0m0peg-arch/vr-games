// Two hands on one object: the second hand gets its own fixed joint where it touched (eased to its controller's pose; the
// first grip is not realigned), either hand can let go and the other keeps holding, the drive moves hands and object as one
// assembly, and the record's attach follows the hand still holding. Claude (Command), Oct 25 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.min.js';
import RAPIER from '../vendor/rapier/dist/rapier.mjs';
import { Room } from '../js/room.js';
import { SceneObjects } from '../js/world/objects.js';
import * as build from '../js/parts/build/index.js';
import { Interact } from '../js/play/interact.js';
import { PhysicsRoom, initPhysics } from '../js/physics/sync.js';
import { createPhysicsWorld, LAYERS } from '../js/dot3d/physics.js';
import { createBus } from '../js/dot3d/bus.js';
await initPhysics();
build.setPhysicsColliders(true);
const DEG=Math.PI/180;
const GRIP_Q=new THREE.Quaternion().setFromEuler(new THREE.Euler(-90*DEG,0,0)); // combat grip r [-90,0,0]
const record=(id,part,p,extra={})=>({id,part,p,ry:0,s:1,label:part,...extra});
const quat=o=>new THREE.Quaternion(o.x,o.y,o.z,o.w);
const vec=o=>new THREE.Vector3(o.x,o.y,o.z);
const pose=(p,q=new THREE.Quaternion())=>({p:new THREE.Vector3(...p),q});
function setup(records) {
  const scene=new THREE.Scene(),room=new Room(),ops=[];
  const objects=new SceneObjects({scene,room,build});
  const send=op=>{ops.push(op);room.apply(op,{local:true});};
  const physics=new PhysicsRoom({objects,room,send});
  room.load({objects:Object.fromEntries(records.map(r=>[r.id,r])),order:records.map(r=>r.id),env:{time:'day'}});
  physics.sync();
  const interact=new Interact({objects,room,send,getUser:()=> 'local',metaOf:build.metaOfRecord});
  const events=[];interact.on('grab',e=>events.push({grab:e}));interact.on('release',e=>events.push({release:e}));
  const tick=(n,hands,each)=>{for(let i=0;i<n;i++){interact.update(1/90,hands);objects.update(1/90,i/90);physics.setHands(hands);physics.update(1/90);each?.(i);}};
  return {scene,room,objects,physics,interact,ops,events,send,tick,dispose(){physics.dispose();objects.dispose();}};
}
// Error of the held body against the hand's grip frame: {angle rad, grip point to palm m}.
function gripError(core,hand,id,gripP) {
  const h=core.hands.get(hand),b=core.props.get(id).body;
  const want=quat(h.body.rotation()).multiply(GRIP_Q);
  const angle=quat(b.rotation()).angleTo(want);
  const point=vec(gripP).applyQuaternion(quat(b.rotation())).add(vec(b.translation()));
  return {angle,gap:point.distanceTo(vec(h.body.translation()))};
}
// Pose of body `id` in hand `hand`'s frame: {offset Vector3, rot Quaternion}.
function relative(core,hand,id) {
  const h=core.hands.get(hand),b=core.props.get(id).body,inv=quat(h.body.rotation()).invert();
  return {offset:vec(b.translation()).sub(vec(h.body.translation())).applyQuaternion(inv),rot:inv.clone().multiply(quat(b.rotation()))};
}
const filterOf=body=>body.collider(0).collisionGroups()&0xffff;
const handOff=(core,name,target)=>({m:vec(core.hands.get(name).body.translation()).distanceTo(target.p),deg:quat(core.hands.get(name).body.rotation()).angleTo(target.q)/DEG});
// A world point on the blade of a held sword: `up` metres past the grip point.
function bladePoint(core,id,up) {
  const b=core.props.get(id).body;
  return new THREE.Vector3(0,.14+up,0).applyQuaternion(quat(b.rotation())).add(vec(b.translation()));
}

test('second hand on a held sword: own joint on the blade, first grip untouched, both hands on their controllers, either hand can let go',()=>{
  const s=setup([record('sword','sword',[.04,1.1,0])]);
  try {
    const core=s.physics.core;
    const right=pose([0,1.1,0]);
    s.tick(3,{right});
    assert.equal(s.interact.grab('right',{point:right.p,quat:right.q}),'sword');
    s.tick(60,{right});
    assert.ok(!core.aligning('right'),'first grip aligned before the second hand arrives');
    const grip0=gripError(core,'right','sword',{x:0,y:.14,z:0});
    assert.ok(grip0.angle<3*DEG&&grip0.gap<.015,'first grip is in the palm');
    // The left controller is moved onto the blade, 0.45 m past the grip point, turned at an angle of its own; it rests
    // against the blade for a third of a second (a free hand pressing on a held thing) before it closes.
    const left=pose(bladePoint(core,'sword',.45).toArray(),new THREE.Quaternion().setFromEuler(new THREE.Euler(.3,.4,.2)));
    s.tick(30,{right,left});
    const pressed=handOff(core,'left',left);
    assert.ok(pressed.deg>5,`the free hand pressed on the blade sits off its controller before the grab: ${pressed.deg.toFixed(1)} deg`);
    const before=quat(core.props.get('sword').body.rotation());
    assert.equal(s.interact.grab('left',{point:left.p,quat:left.q}),'sword','the second hand takes hold of the blade');
    const hl=core.hands.get('left'),hr=core.hands.get('right'),b=core.props.get('sword').body;
    assert.ok(hl.joint&&hr.joint,'both hands hold by a joint');
    assert.ok(!core.aligning('right'),'the first grip is not realigned');
    assert.ok(quat(b.rotation()).angleTo(before)<1*DEG,'the sword does not jump when the second hand closes');
    assert.deepEqual(core.holders('sword').sort(),['left','right']);
    assert.equal(s.room.get('sword').attach.hand,'right','the record stays attached to the first hand');
    assert.equal(s.interact.held('left'),'sword');assert.equal(s.interact.held('right'),'sword');
    assert.ok(s.events.some(e=>e.grab?.hand==='left'&&e.grab.second===true),'grab event marks the second hand');
    assert.equal(filterOf(b)&(LAYERS.HAND_L|LAYERS.HAND_R),0,'the held sword collides with neither hand');
    let maxStep=0,prev=before;
    s.tick(60,{right,left},()=>{const q=quat(b.rotation());maxStep=Math.max(maxStep,q.angleTo(prev));prev=q;});
    assert.ok(maxStep<6*DEG,`the second joint eases to the controller, never one jump: biggest step ${(maxStep/DEG).toFixed(1)} deg`);
    assert.ok(!core.aligning('left'),'second-hand easing finished within half a second');
    const rel0=relative(core,'left','sword');
    s.tick(90,{right,left});
    const rel1=relative(core,'left','sword');
    assert.ok(rel0.offset.distanceTo(rel1.offset)<.005&&rel0.rot.angleTo(rel1.rot)<1*DEG,`second hand holds steady on the blade: ${rel0.offset.distanceTo(rel1.offset).toFixed(4)} m, ${(rel0.rot.angleTo(rel1.rot)/DEG).toFixed(2)} deg`);
    const grip1=gripError(core,'right','sword',{x:0,y:.14,z:0});
    assert.ok(grip1.angle<3*DEG&&grip1.gap<.015,`first grip unchanged with two hands on: ${(grip1.angle/DEG).toFixed(2)} deg, ${grip1.gap.toFixed(4)} m`);
    for(const [name,t] of [['left',left],['right',right]]){const o=handOff(core,name,t);assert.ok(o.m<.02&&o.deg<4,`${name} hand on its controller with two hands on: ${o.m.toFixed(4)} m, ${o.deg.toFixed(2)} deg`);}
    // The first hand lets go and moves away: the second keeps the sword up, and the record's attach moves over.
    const y0=b.translation().y;
    assert.equal(s.interact.release('right'),'sword');
    assert.ok(!hr.joint&&hr.id===null&&hl.joint&&hl.id==='sword','right released, left still holds');
    assert.equal(s.room.get('sword').attach?.hand,'left','the attach is handed to the hand still holding');
    assert.equal(s.room.get('sword').attach?.user,'local');
    assert.equal(s.interact.held('right'),null);assert.equal(s.interact.held('left'),'sword');
    assert.equal(filterOf(b)&LAYERS.HAND_R,LAYERS.HAND_R,'the sword can meet the right hand again');
    assert.equal(filterOf(b)&LAYERS.HAND_L,0,'but still not the hand holding it');
    right.p.x-=.4;
    s.tick(90,{right,left});
    assert.ok(hl.joint&&Math.abs(b.translation().y-y0)<.03,`one hand keeps the sword up by the blade: moved ${(b.translation().y-y0).toFixed(3)} m`);
    const o=handOff(core,'left',left);assert.ok(o.m<.02&&o.deg<4,`left hand still on its controller: ${o.m.toFixed(4)} m, ${o.deg.toFixed(2)} deg`);
    assert.equal(s.events.filter(e=>e.release).length,1);
    assert.equal(s.events.find(e=>e.release).release.thrown,false,'a hand-over is not a throw');
    // The last hand lets go: a free prop again, no attach.
    assert.equal(s.interact.release('left'),'sword');
    assert.ok(!s.room.get('sword').attach);
    assert.equal(core.holders('sword').length,0);
    assert.equal(filterOf(b),LAYERS.ALL,'free prop collides with everything');
    left.p.x+=.4;
    s.tick(45,{right,left});
    assert.ok(b.translation().y<y0-.1&&b.isDynamic(),'the dropped sword falls');
  }finally{s.dispose();}
});

test('the second hand can let go first; a pull or a grab during a pull never steals a held object; releaseAll empties both hands',()=>{
  const s=setup([record('crate','crate',[.5,0,0]),record('ball','ball',[0,0,-3])]);
  try {
    const core=s.physics.core;
    const right=pose([0,.95,0],new THREE.Quaternion().setFromEuler(new THREE.Euler(.4,.2,0)));
    s.tick(3,{right});
    assert.equal(s.interact.grab('right',{point:right.p,quat:right.q}),'crate');
    const left=pose([.6,.95,0]);
    s.tick(3,{right,left});
    assert.equal(s.interact.grab('left',{point:left.p,quat:left.q}),'crate');
    assert.deepEqual(core.holders('crate').sort(),['left','right']);
    assert.equal(s.interact.release('left'),'crate');
    assert.equal(s.room.get('crate').attach.hand,'right','the second hand letting go changes nothing for the first');
    assert.equal(s.interact.held('right'),'crate');assert.equal(s.interact.held('left'),null);
    assert.equal(s.events.find(e=>e.release).release.second,true);
    const far=pose([2,1.2,2]);
    s.tick(3,{right,left:far});
    assert.equal(core.pull('left','crate',{x:.5,y:.4,z:0}),false,'a pull never takes what the other hand holds');
    assert.equal(s.interact.release('right'),'crate');
    assert.ok(!s.room.get('crate').attach);
    // The right hand steps back from the crate. While it pulls the ball in, the left cannot grab the ball; once it arrives the left can join.
    right.p.set(-.6,1.2,.3);
    const ray=new THREE.Raycaster(right.p.clone(),new THREE.Vector3(0,.11,-3).sub(right.p).normalize());
    s.tick(30,{right,left:far});
    assert.equal(s.interact.grab('right',{point:right.p,quat:right.q,raycaster:ray}),'ball');
    const hr=core.hands.get('right');
    assert.ok(hr.pull&&!hr.joint,'the ball is on its way in');
    assert.equal(core.grab('left','ball'),false,'no grab while the other hand pulls it in');
    let arrived=-1;
    s.tick(360,{right,left:far},i=>{if(arrived<0&&hr.joint)arrived=i;});
    assert.ok(arrived>=0,'the ball arrives');
    const b=core.props.get('ball').body;
    const here=pose(vec(b.translation()).toArray());
    s.tick(30,{right,left:here}); // the left hand travels over to the ball
    assert.equal(s.interact.grab('left',{point:here.p,quat:here.q}),'ball','once held, the second hand can join');
    assert.deepEqual(core.holders('ball').sort(),['left','right']);
    s.tick(3,{right,left:here});
    assert.deepEqual(s.interact.releaseAll(),['ball','ball'],'releaseAll empties both hands: the second hand first, then the attached one');
    assert.deepEqual(s.interact.releaseAll(),[],'nothing left to release');
    assert.ok(!s.room.get('ball').attach);
    assert.equal(core.holders('ball').length,0);
  }finally{s.dispose();}
});

test('two hands carry a chair as one assembly: it follows both controllers without overshoot, and lost tracking hands it over',()=>{
  const s=setup([record('shield','chair',[.3,0,0])]);
  try {
    const core=s.physics.core;
    assert.ok(core.props.get('shield').body.mass()>5,'the chair is a real load');
    assert.equal(build.metaOfRecord(s.room.get('shield')).grip,undefined,'held where touched, no grip');
    const right=pose([.12,.45,0]),left=pose([.48,.45,0]);
    s.tick(3,{right,left});
    // Both hands close on it two frames apart, as they do on a thing you lift with both hands.
    assert.equal(s.interact.grab('right',{point:right.p,quat:right.q}),'shield');
    s.tick(2,{right,left});
    assert.equal(s.interact.grab('left',{point:left.p,quat:left.q}),'shield');
    const b=core.props.get('shield').body;
    s.tick(60,{right,left});
    assert.ok(!core.aligning('left')&&!core.aligning('right'),'both ramps done');
    for(const [name,t] of [['left',left],['right',right]]){const o=handOff(core,name,t);assert.ok(o.m<.03&&o.deg<5,`${name} hand on its controller after closing together: ${o.m.toFixed(4)} m, ${o.deg.toFixed(2)} deg`);}
    const start=vec(b.translation());
    // Both controllers rise 0.3 m and move 0.5 m forward over two thirds of a second, then hold.
    let maxOvershoot=0;
    const goal=new THREE.Vector3(0,.3,-.5),dir=goal.clone().normalize();
    s.tick(90,{right,left},i=>{
      const u=Math.min(1,(i+1)/60),k=u*u*(3-2*u);
      right.p.set(.12,.45+.3*k,-.5*k);left.p.set(.48,.45+.3*k,-.5*k);
      maxOvershoot=Math.max(maxOvershoot,vec(b.translation()).sub(start).dot(dir)-goal.length());
    });
    s.tick(60,{right,left});
    const moved=vec(b.translation()).sub(start);
    assert.ok(moved.distanceTo(goal)<.04,`the shield followed both hands: ${moved.toArray().map(n=>n.toFixed(3)).join(', ')} vs ${goal.toArray().join(', ')}`);
    assert.ok(maxOvershoot<.03,`no overshoot from two hands pushing the same correction: ${maxOvershoot.toFixed(3)} m`);
    for(const [name,t] of [['left',left],['right',right]]){const o=handOff(core,name,t);assert.ok(o.m<.03&&o.deg<5,`${name} hand on its controller: ${o.m.toFixed(4)} m, ${o.deg.toFixed(2)} deg`);}
    const w=b.angvel();
    assert.ok(Math.hypot(w.x,w.y,w.z)<.3,`the shield is not spun up between the hands: ${Math.hypot(w.x,w.y,w.z).toFixed(3)} rad/s`);
    // The attached (right) controller loses tracking: the core drops that hand, the left keeps the shield, the attach moves.
    const y1=b.translation().y;
    s.tick(3,{left});
    assert.ok(!core.hands.has('right')&&core.hands.get('left').joint,'right hand gone, left still holds');
    assert.equal(s.room.get('shield').attach?.hand,'left','attach handed to the hand still holding when the first lost tracking');
    assert.equal(s.interact.held('left'),'shield');assert.equal(s.interact.held('right'),null);
    s.tick(60,{left});
    assert.ok(core.hands.get('left').joint&&Math.abs(b.translation().y-y1)<.06,`the shield stays up in the one hand: moved ${(b.translation().y-y1).toFixed(3)} m`);
    assert.equal(s.interact.release('left'),'shield');
    assert.ok(!s.room.get('shield').attach);
    s.tick(45,{left});
    assert.ok(b.translation().y<y1-.1,'the dropped shield falls');
  }finally{s.dispose();}
});

test('core: holders, layers and the shared drive with two hands turning one body (no sync layer)',()=>{
  const core=createPhysicsWorld(RAPIER,createBus());
  try {
    core.add('__floor',{p:{x:0,y:-.1,z:0},fixed:true,shapes:[{p:{x:0,y:0,z:0},size:{x:40,y:.2,z:40},material:'stone'}]});
    core.add('plank',{p:{x:0,y:1,z:0},shapes:[{p:{x:0,y:0,z:0},size:{x:1.2,y:.04,z:.1},material:'wood'}]});
    const right={p:new THREE.Vector3(-.5,1,0),q:new THREE.Quaternion()},left={p:new THREE.Vector3(.5,1,0),q:new THREE.Quaternion()};
    for(let i=0;i<5;i++){core.targetHand('right',right);core.targetHand('left',left);core.advance(1/90);}
    assert.equal(core.grab('right','plank'),true);
    assert.equal(core.grab('left','plank'),true);
    assert.equal(core.grab('left','plank'),false,'a hand holds one thing once');
    assert.deepEqual(core.holders('plank').sort(),['left','right']);
    const b=core.props.get('plank').body;
    assert.equal(filterOf(b),LAYERS.ALL&~(LAYERS.HAND_L|LAYERS.HAND_R));
    // Turn both controllers 60 degrees about the vertical, together: the plank turns with them.
    const turn=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),60*DEG);
    for(let i=0;i<60;i++){
      const u=Math.min(1,(i+1)/40),k=u*u*(3-2*u);
      const q=new THREE.Quaternion().slerp(turn,k);
      right.q.copy(q);left.q.copy(q);
      right.p.set(-.5,1,0).applyQuaternion(q);left.p.set(.5,1,0).applyQuaternion(q);
      core.targetHand('right',right);core.targetHand('left',left);core.advance(1/90);
    }
    assert.ok(quat(b.rotation()).angleTo(turn)<3*DEG,`plank turned with both hands: ${(quat(b.rotation()).angleTo(turn)/DEG).toFixed(2)} deg off`);
    assert.ok(vec(b.translation()).distanceTo(new THREE.Vector3(0,1,0))<.03,'plank centre stayed put while turning');
    assert.equal(core.release('left'),'plank');
    assert.equal(filterOf(b),LAYERS.ALL&~LAYERS.HAND_R,'still held by the right hand only');
    assert.deepEqual(core.holders('plank'),['right']);
    assert.equal(core.release('right'),'plank');
    assert.equal(filterOf(b),LAYERS.ALL);
    assert.equal(core.holders('plank').length,0);
  }finally{core.dispose();}
});
