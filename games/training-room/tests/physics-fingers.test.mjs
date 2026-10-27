// Articulated hands: a palm with fingers and a thumb replaces the box palm; open / point / fist from the controller
// buttons; a holding hand closes until each finger meets the held body (fitted through the hold joint); the shown curls
// ease, never snap. Claude (Command), Oct 25 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.min.js';
import { Room } from '../js/room.js';
import { SceneObjects } from '../js/world/objects.js';
import * as build from '../js/parts/build/index.js';
import { Interact } from '../js/play/interact.js';
import { PhysicsRoom, initPhysics } from '../js/physics/sync.js';
import { FINGERS, REST, chain, jointRotations, makeHandRig, targetCurls, fitCurls } from '../js/physics/hand-rig.js';
await initPhysics();
build.setPhysicsColliders(true);
const record=(id,part,p,extra={})=>({id,part,p,ry:0,s:1,label:part,...extra});
const pose=(p,q=new THREE.Quaternion())=>({p:new THREE.Vector3(...p),q});
const near=(a,b,tol)=>Math.abs(a-b)<=tol;
function setup(records) {
  const scene=new THREE.Scene(),room=new Room();
  const objects=new SceneObjects({scene,room,build});
  const send=op=>room.apply(op,{local:true});
  const physics=new PhysicsRoom({objects,room,send,scene});
  room.load({objects:Object.fromEntries(records.map(r=>[r.id,r])),order:records.map(r=>r.id),env:{time:'day'}});
  physics.sync();
  const interact=new Interact({objects,room,send,getUser:()=> 'local',metaOf:build.metaOfRecord});
  const tick=(n,hands,inputs,each)=>{for(let i=0;i<n;i++){interact.update(1/90,hands);objects.update(1/90,i/90);physics.setHands(hands,inputs);physics.update(1/90);each?.(i);}};
  return {scene,room,objects,physics,interact,tick,dispose(){physics.dispose();objects.dispose();}};
}
// Per finger: the smallest signed clearance of its shown sample points to body `id`, and the deepest surface sink (clearance - radius).
function contact(s,hand,id) {
  const pts=s.physics.fingerPoints(hand),out={};
  for(const name of FINGERS){const mine=pts.filter(p=>p.finger===name);const cl=mine.map(p=>s.physics.core.clearance(id,p.p));
    out[name]={min:Math.min(...cl),sink:Math.min(...cl.map((c,i)=>c-mine[i].r)),r:mine[0].r};}
  return out;
}

test('hand kinematics: straight fingers, a fist around the controller handle, a left hand that mirrors the right, visuals built from the same joint math',()=>{
  for(const name of ['index','middle','ring','pinky']) {
    const open=chain(name,0,'right'),tipOpen=open[open.length-1].p;
    assert.ok(tipOpen.y<-.08&&near(tipOpen.x,.033,.001),`${name} open points straight out of the palm: ${tipOpen.toArray()}`);
    const fist=chain(name,1,'right'),tipFist=fist[fist.length-1].p;
    assert.ok(Math.hypot(tipFist.x,tipFist.y)<.025,`${name} fist tip wraps round the handle axis (rod distance ${Math.hypot(tipFist.x,tipFist.y).toFixed(3)} m)`);
    assert.ok(tipFist.x<tipOpen.x,`${name} curls toward the palm side (-X on the right hand)`);
  }
  const thumbOpen=chain('thumb',0,'right').at(-1).p,thumbFist=chain('thumb',1,'right').at(-1).p;
  assert.ok(thumbOpen.z<-.08,'open thumb points forward past the controller face');
  assert.ok(thumbFist.x<-.02&&thumbFist.z>-.03,'closed thumb folds across the palm');
  for(const name of FINGERS) for(const c of [0,.5,1]) {
    const r=chain(name,c,'right'),l=chain(name,c,'left');
    assert.equal(r.length,l.length);
    r.forEach((s,i)=>{assert.ok(near(s.p.x,-l[i].p.x,1e-9)&&near(s.p.y,l[i].p.y,1e-9)&&near(s.p.z,l[i].p.z,1e-9),`${name} at ${c}: left is the right mirrored in X`);assert.equal(s.r,l[i].r);});
  }
  const rig=makeHandRig('right');
  rig.setCurls([.7,.3,.6,.9,1]);rig.root.updateMatrixWorld(true);
  let fingerMeshes=0;rig.root.traverse(o=>{if(o.userData.part==='finger')fingerMeshes++;});
  assert.equal(fingerMeshes,14,'four fingers of three segments and a thumb of two');
  assert.ok(rig.root.children.some(o=>o.userData.part==='palm')&&rig.root.children.some(o=>o.userData.part==='cuff'),'palm and cuff');
  FINGERS.forEach((name,i)=>{
    const ch=chain(name,rig.curls[i],'right'),joints=rig.fingers[name];
    joints.forEach((j,k)=>{if(!k)return;const w=new THREE.Vector3();j.getWorldPosition(w);assert.ok(w.distanceTo(ch[2*k-1].p)<1e-9,`${name} joint ${k} sits where the chain math puts it`);});
    const last=joints.at(-1),tip=new THREE.Vector3(0,last.children[0].position.y*2,0).applyMatrix4(last.matrixWorld);
    assert.ok(tip.distanceTo(ch.at(-1).p)<1e-9,`${name} tip matches the chain math`);
  });
  const {rotations}=jointRotations('index',.5,'left');
  assert.equal(rotations.length,3);
});

test('poses from the controller: relaxed open, point on squeeze, fist on squeeze and trigger, thumb up off the buttons; a holding hand closes',()=>{
  assert.deepEqual(targetCurls({trigger:0,squeeze:0,thumb:false}),[REST,REST,REST,REST,REST]);
  assert.deepEqual(targetCurls(undefined),[REST,REST,REST,REST,REST],'no input is a relaxed hand');
  assert.deepEqual(targetCurls({trigger:0,squeeze:1,thumb:true}),[1,REST,1,1,1],'point');
  assert.deepEqual(targetCurls({trigger:1,squeeze:1,thumb:true}),[1,1,1,1,1],'fist');
  const half=targetCurls({trigger:.5,squeeze:.25,thumb:false});
  assert.ok(near(half[1],REST+.5*(1-REST),1e-9)&&near(half[2],REST+.25*(1-REST),1e-9)&&half[0]===REST,'analog trigger and squeeze');
  assert.deepEqual(targetCurls({trigger:0,squeeze:0,thumb:false},true),[1,1,1,1,1],'a hand holding something closes whatever the buttons say');
  assert.deepEqual(targetCurls({trigger:7,squeeze:-1,thumb:0}),[REST,1,REST,REST,REST],'values are clamped');
});

test('fitCurls: free fingers keep their target, a blocked finger stops at the contact, a finger blocked everywhere presses in least',()=>{
  // A wall at hand-space y = -0.06 blocks the straight fingers (they reach y -0.1); curling lifts the tips above it.
  const wall=(p,r)=>(p.y+.06)-r*0;
  const free=fitCurls([1,1,1,1,1],'right',()=>1);
  assert.deepEqual(free,[1,1,1,1,1]);
  const half=fitCurls([.5,.5,.5,.5,.5],'right',()=>1);
  assert.deepEqual(half,[.5,.5,.5,.5,.5],'the target is the upper bound');
  // Rod of radius 0.02 along Z through the origin (the controller handle): a fist stops on it, an open hand is free.
  const rod=(p,r)=>Math.hypot(p.x,p.y)-.02-r*.5;
  const fist=fitCurls([1,1,1,1,1],'right',rod);
  for(const i of [1,2,3,4]) {
    assert.ok(fist[i]>.3&&fist[i]<.95,`${FINGERS[i]} stops on the rod at ${fist[i].toFixed(3)}`);
    const worst=Math.min(...chain(FINGERS[i],fist[i],'right').map(s=>rod(s.p,s.r)));
    assert.ok(worst>=-1e-9,`${FINGERS[i]} does not press into the rod (${worst})`);
    const over=Math.min(...chain(FINGERS[i],Math.min(1,fist[i]+.02),'right').map(s=>rod(s.p,s.r)));
    assert.ok(over<0,`${FINGERS[i]} is at the contact: a little more curl presses in`);
  }
  const open=fitCurls([REST,REST,REST,REST,REST],'right',rod);
  assert.deepEqual(open.slice(1),[REST,REST,REST,REST],'relaxed fingers clear the rod (the open thumb points along this endless rod and takes its least-penetrating curl)');
  // Blocked at every curl: take the curl that presses in least (here the margin is worst at 0 and best at 1).
  const least=fitCurls([1,1,1,1,1],'right',(p)=>-(.2-p.x*0+Math.max(0,-p.y)));
  for(const i of [1,2,3,4]) assert.ok(least[i]>.8,`${FINGERS[i]} picks the least-penetrating curl when nothing is free: ${least[i]}`);
  void wall;
});

test('a held sword: the fingers close on the handle and stop there, the hand visuals show it, release opens the hand',()=>{
  const s=setup([record('sword','sword',[.04,1.1,0])]);
  try {
    const right=pose([0,1.1,0]);
    s.tick(3,{right});
    const before=s.physics.fingers('right');
    assert.ok(before&&before.curl.every(c=>near(c,REST,.01)),'a free hand with no input rests open');
    assert.equal(s.interact.grab('right',{point:right.p,quat:right.q}),'sword');
    let maxStep=0,prev=s.physics.fingers('right').curl.slice();
    s.tick(60,{right},null,()=>{const c=s.physics.fingers('right').curl;maxStep=Math.max(maxStep,...c.map((v,i)=>Math.abs(v-prev[i])));prev=c.slice();});
    const f=s.physics.fingers('right');
    assert.equal(f.against,'sword');
    assert.ok(maxStep<.25,`curls ease, never snap: biggest step ${maxStep.toFixed(3)}`);
    assert.ok(!s.physics.core.aligning('right'),'grip ramp finished');
    const c=contact(s,'right','sword');
    for(const name of ['index','middle','ring','pinky']) {
      const i=FINGERS.indexOf(name);
      assert.ok(f.fitted[i]>.3&&f.fitted[i]<.95,`${name} fitted between open and a full fist: ${f.fitted[i].toFixed(3)}`);
      assert.ok(near(f.curl[i],f.fitted[i],.02),`${name} shown curl reached the fit`);
      assert.ok(c[name].min>=c[name].r*.5-.002,`${name} does not sink past half its radius into the handle (clearance ${c[name].min.toFixed(4)} m)`);
      assert.ok(c[name].min<=c[name].r*.5+.004,`${name} touches the handle (clearance ${c[name].min.toFixed(4)} m, radius ${c[name].r})`);
    }
    assert.ok(f.fitted[0]>0&&f.fitted[0]<=1,'the thumb takes a curl of its own');
    // Visuals: the rig stands at the hand body with the shown curls on its joints; the ghost hides while the hand is on its controller.
    const vis=s.physics.visuals.get('right'),h=s.physics.core.hands.get('right');
    assert.ok(vis.rig.root.parent===s.scene&&vis.rig.root.visible,'hand rig in the scene');
    assert.ok(vis.rig.root.position.distanceTo(new THREE.Vector3().copy(h.body.translation()))<1e-9,'rig at the hand body');
    const q=jointRotations('index',f.curl[1],'right').rotations[1];
    assert.ok(vis.rig.fingers.index[1].quaternion.angleTo(q)<1e-9,'index joint posed at the shown curl');
    assert.equal(vis.ghost.root.visible,false,'ghost hidden while the hand sits on its controller');
    let fingerMeshes=0;s.scene.traverse(o=>{if(o.userData.part==='finger'&&o.visible)fingerMeshes++;});
    assert.equal(fingerMeshes,56,'two hands and two ghosts of 14 finger segments each are in the scene');
    const fits=f.fitTarget.slice();
    s.tick(90,{right});
    assert.deepEqual(s.physics.fingers('right').fitTarget,fits,'a settled hold is not refitted every frame');
    assert.equal(s.interact.release('right'),'sword');
    s.tick(45,{right});
    const after=s.physics.fingers('right');
    assert.ok(after.curl.every(v=>near(v,REST,.01))&&after.against===null,'the hand opens after the release');
  } finally { s.dispose(); }
});

test('a held axe: the fingers close on its thicker handle; a chair held by a post gives a full fist with nothing in reach',()=>{
  const s=setup([record('axe','axe',[.04,1.1,0]),record('chair','chair',[1.5,0,0])]);
  try {
    const right=pose([0,1.1,0]);
    s.tick(3,{right});
    assert.equal(s.interact.grab('right',{point:right.p,quat:right.q}),'axe');
    s.tick(90,{right});
    const f=s.physics.fingers('right'),c=contact(s,'right','axe');
    assert.equal(f.against,'axe');
    for(const name of ['index','middle','ring','pinky']) {
      const i=FINGERS.indexOf(name);
      assert.ok(f.fitted[i]>(name==='pinky'?.15:.3)&&f.fitted[i]<.95,`${name} stops on the axe handle (the short pinky meets the thick haft early): ${f.fitted[i].toFixed(3)}`);
      assert.ok(c[name].min>=c[name].r*.5-.002,`${name} does not sink into the axe (clearance ${c[name].min.toFixed(4)})`);
      assert.ok(c[name].min<=c[name].r*.5+.004,`${name} touches the axe handle (clearance ${c[name].min.toFixed(4)})`);
    }
    assert.equal(s.interact.release('right'),'axe');
    s.tick(30,{right});
    const chairTop=s.objects.bounds('chair').max.y;
    const left=pose([1.5,chairTop-.02,.2]);
    s.tick(3,{right,left});
    assert.equal(s.interact.grab('left',{point:left.p,quat:left.q}),'chair');
    s.tick(60,{right,left});
    const g=s.physics.fingers('left'),cc=contact(s,'left','chair');
    assert.equal(g.against,'chair');
    assert.ok(g.target.every(t=>t===1),'a holding hand closes');
    for(const name of FINGERS) assert.ok(cc[name].min>=cc[name].r*.5-.002,`${name} never sinks into the chair`);
    assert.ok(g.fitted.slice(1).every(v=>v>.5),'the fingers close as far as the chair lets them: '+g.fitted.map(v=>v.toFixed(2)));
  } finally { s.dispose(); }
});
