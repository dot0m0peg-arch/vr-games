// Contact hits, the player's side (js/physics/hits.js): the controller on the striker pulses scaled by the impulse, the
// existing Sfx plays the material's hit, the dot3d decals and particles land at the real contact point on the wall, and a
// 'hit' bus event carries it. Owner, Oct 23 2026 (Codex transmitter): "If I smack a wall with my sword, it should put an
// axe mark into the wall. It should do something". Claude (Command), Oct 26 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.min.js';
import { Room } from '../js/room.js';
import { SceneObjects } from '../js/world/objects.js';
import * as build from '../js/parts/build/index.js';
import { Interact } from '../js/play/interact.js';
import { PhysicsRoom, initPhysics } from '../js/physics/sync.js';
import { createHitEffects, hapticFor, HAPTIC_MIN_IMPULSE, SOUND_MIN_IMPULSE } from '../js/physics/hits.js';
import { createDecals } from '../js/dot3d/decals.js';
import { createParticles } from '../js/dot3d/particles.js';
import { createBus } from '../js/dot3d/bus.js';
import { Sfx } from '../js/play/sfx.js';
await initPhysics();
build.setPhysicsColliders(true);
const DEG=Math.PI/180;
const record=(id,part,p,extra={})=>({id,part,p,ry:0,s:1,label:part,...extra});
// The same physics wall main.js seeds in the candidate: 5 x 3 x 0.1 m of stone. At z=-1.2 its near face is at z=-1.15.
const WALL={blueprint:{name:'physics wall',size:[5,3,.1],parts:[{shape:'box',p:[0,1.5,0],s:[5,3,.1],mat:'stone',color:'#818b91'}]}};
const FACE=-1.15;
const FLAT=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),-90*DEG);
const flat={physicsPose:[FLAT.x,FLAT.y,FLAT.z,FLAT.w]};
function setup(records) {
  const scene=new THREE.Scene(),room=new Room(),ops=[];
  const objects=new SceneObjects({scene,room,build});
  const send=op=>{ops.push(op);room.apply(op,{local:true});};
  const physics=new PhysicsRoom({objects,room,send});
  room.load({objects:Object.fromEntries(records.map(r=>[r.id,r])),order:records.map(r=>r.id),env:{time:'day'}});
  physics.sync();
  const interact=new Interact({objects,room,send,getUser:()=> 'local',metaOf:build.metaOfRecord});
  const contacts=[],hits=[],pulses=[],sounds=[];
  physics.bus.on('contact',e=>contacts.push(e));physics.bus.on('hit',e=>hits.push(e));
  const decals=createDecals(THREE,{scene,bus:physics.bus,maxDecals:64});
  const particles=createParticles(THREE,{scene,bus:physics.bus,maxParticles:256});
  const sfx={hit:(p,o)=>sounds.push({p,...o,time:physics.core.contacts.stats().time})};
  const fx=createHitEffects({bus:physics.bus,core:physics.core,sfx,haptic:(hand,intensity,ms)=>{pulses.push({hand,intensity,ms});return true;}});
  const tick=(n,hands)=>{for(let i=0;i<n;i++){objects.update(1/90,i/90);physics.setHands(hands);physics.update(1/90);particles.update(1/90);decals.update(1/90);}};
  return {scene,room,objects,physics,interact,tick,contacts,hits,pulses,sounds,decals,particles,fx,dispose(){fx.dispose();physics.dispose();objects.dispose();}};
}
const vec=o=>new THREE.Vector3(o.x,o.y,o.z),quat=o=>new THREE.Quaternion(o.x,o.y,o.z,o.w);
// Raised hand 0.1 m ahead of the player, palm forward: the combat grip points the blade straight at the wall (-z).
const raised=()=>({p:new THREE.Vector3(0,1.4,-.1),q:new THREE.Quaternion()});
const swingTarget=()=>({p:new THREE.Vector3(0,1.4,-1.0),q:new THREE.Quaternion()}); // 0.9 m ahead, through the wall
// Pick the sword up off the floor, let the grip settle, raise it at the wall. Returns the tip's gap to the wall face.
function armSword(s) {
  const hand={p:new THREE.Vector3(0,1.1,0),q:new THREE.Quaternion()};
  s.physics.setHands({right:hand});
  assert.equal(s.interact.grab('right',{point:hand.p,quat:hand.q}),'sword');
  s.tick(120,{right:hand});
  s.tick(90,{right:raised()});
  const b=s.physics.entries.get('sword').body;
  const tip=new THREE.Vector3(0,1,0).applyQuaternion(quat(b.rotation())).add(vec(b.translation()));
  assert.ok(Math.abs(tip.x)<.05&&Math.abs(tip.y-1.4)<.05&&tip.z<-.8,`blade points at the wall: tip ${tip.toArray().map(v=>v.toFixed(2))}`);
  return tip.z-FACE;
}
// Decals on the wall face: the solver's contact point can sit up to ~1.5 cm into the face (CCD stops the blade there).
const wallDecals=s=>{const {aPos,aSize}=s.decals.state.attributes;let n=0;for(let i=0;i<s.decals.state.capacity;i++)if(s.decals.state.alive[i]&&Math.abs(aPos.array[i*3+2]-FACE)<.03&&aSize.array[i*2]>=.05)n++;return n;};

test('hapticFor: nothing below the threshold, a nudge for a tap, full for a swing, capped',()=>{
  assert.equal(hapticFor(0),null);assert.equal(hapticFor(HAPTIC_MIN_IMPULSE/2),null);assert.equal(hapticFor(NaN),null);assert.equal(hapticFor(-3),null);
  const tap=hapticFor(1),medium=hapticFor(3),swing=hapticFor(20),huge=hapticFor(500);
  assert.ok(tap.intensity>.3&&tap.intensity<.45,`a 1 N*s tap is a nudge: ${tap.intensity}`);
  assert.ok(tap.intensity<medium.intensity&&medium.intensity<swing.intensity,'harder hits pulse harder');
  assert.ok(tap.ms<medium.ms&&medium.ms<swing.ms,'and longer');
  assert.ok(swing.intensity>.85,`a 20 N*s swing is nearly full: ${swing.intensity}`);
  assert.equal(huge.intensity,1);assert.equal(huge.ms,120);
  assert.ok(Number.isInteger(tap.ms)&&tap.ms>=20);
});

test('a held sword swung into the stone wall: scuff and chips at the contact point on the wall face, the right controller pulses hard, one stone hit sound, a hit event',()=>{
  const s=setup([record('sword','sword',[.04,1.1,0],{data:flat}),record('wall','physics wall',[0,0,-1.2],{data:WALL})]);
  try {
    armSword(s);
    assert.equal(s.hits.length,0,'picking up, holding and carrying the sword fires no hit');
    assert.equal(s.decals.count(),0);assert.equal(s.sounds.length,0);
    const spawnedBefore=s.particles.stats().spawnedTotal;
    s.tick(60,{right:swingTarget()});
    assert.ok(s.hits.length>=1,'the swing is felt');
    const hit=s.hits[0];
    assert.equal(hit.hand,'right');assert.equal(hit.id,'sword');
    assert.ok(hit.impulse>=10,`a full swing lands hard (hand and sword stop as one): ${hit.impulse.toFixed(2)} N*s`);
    assert.ok(hit.intensity>=.85&&hit.intensity<=1,`full pulse: ${hit.intensity}`);
    assert.ok(Math.abs(hit.point.z-FACE)<.03,`contact point on the wall face: z ${hit.point.z.toFixed(3)}`);
    assert.ok(hit.point.y>1&&hit.point.y<1.8,`at sword height: y ${hit.point.y.toFixed(2)}`);
    assert.ok(hit.normal.z>.99,'normal out of the wall toward the player');
    assert.ok(hit.materials.includes('stone'),'the wall is stone: '+hit.materials);
    assert.deepEqual(s.pulses[0],{hand:'right',intensity:hit.intensity,ms:hit.ms},'the controller got exactly that pulse');
    assert.equal(s.sounds.length,1,'one hit sound for the swing, not one per blade collider');
    assert.ok(s.sounds[0].materials.includes('stone')&&s.sounds[0].impulse>=SOUND_MIN_IMPULSE);
    assert.ok(Math.abs(s.sounds[0].p.z-FACE)<.03,'the sound is at the contact point');
    assert.ok(s.decals.count()>=1&&wallDecals(s)>=1,`a scuff on the wall face: ${s.decals.count()} decals, ${wallDecals(s)} on the wall`);
    const st=s.particles.stats();
    assert.ok(st.spawnedTotal>spawnedBefore&&st.byKind.chips>0&&st.byKind.dust>0,'stone chips and dust spawned: '+JSON.stringify(st.byKind));
    assert.ok(s.contacts.every(c=>c.impulse>0&&Number.isFinite(c.time)),'bus contacts carry impulse and time');
  } finally { s.dispose(); }
});

test('a tap at walking pace is a nudge and a swing is full: the pulse, its length and the mark scale with the impulse',()=>{
  const s=setup([record('sword','sword',[.04,1.1,0],{data:flat}),record('wall','physics wall',[0,0,-1.2],{data:WALL})]);
  try {
    const gap=armSword(s);
    assert.ok(gap>.1&&gap<.3,`tip short of the wall by ${gap.toFixed(3)} m`);
    // Walk the controller toward the wall at 0.5 m/s until the tip would be 3 cm into the face, then hold it there.
    const h=raised(),end=h.p.z-gap-.03;
    for(let i=0;i<120;i++){h.p.z=Math.max(end,h.p.z-.5/90);s.tick(1,{right:h});}
    assert.ok(s.hits.length>=1,'the tap is felt');
    const tap=s.hits[0],tapDecals=s.decals.count();
    assert.ok(tap.impulse>=HAPTIC_MIN_IMPULSE&&tap.impulse<4,`a tap is light: ${tap.impulse.toFixed(2)} N*s`);
    assert.ok(tap.intensity>.25&&tap.intensity<.55,`a nudge: ${tap.intensity.toFixed(2)}`);
    assert.ok(s.hits.length<=2,`holding the sword against the wall does not keep pulsing: ${s.hits.length} hits`);
    assert.ok(tapDecals>=1,'even a tap leaves a mark');
    s.tick(90,{right:raised()});
    const before=s.hits.length;
    s.tick(60,{right:swingTarget()});
    assert.ok(s.hits.length>before,'the swing is felt');
    const swing=s.hits[before];
    assert.ok(swing.impulse>tap.impulse*3,`swing ${swing.impulse.toFixed(2)} vs tap ${tap.impulse.toFixed(2)} N*s`);
    assert.ok(swing.intensity>tap.intensity+.3&&swing.ms>tap.ms,`swing pulse ${swing.intensity.toFixed(2)}/${swing.ms} ms vs tap ${tap.intensity.toFixed(2)}/${tap.ms} ms`);
    const sizeOf=i=>s.decals.state.attributes.aSize.array[i*2];
    const sizes=[];for(let i=0;i<s.decals.state.capacity;i++)if(s.decals.state.alive[i])sizes.push(sizeOf(i));
    assert.ok(Math.max(...sizes)>Math.min(...sizes)*1.3,'the swing leaves a bigger mark than the tap: '+sizes.map(v=>v.toFixed(3)));
  } finally { s.dispose(); }
});

test('a crate dropped on the floor marks and sounds but no hand feels it; four corners landing at once are one thud',()=>{
  const s=setup([record('crate','crate',[0,1.5,0])]);
  try {
    s.tick(200,{});
    assert.ok(s.contacts.length>=4,'the corners hit the floor: '+s.contacts.length);
    assert.equal(s.hits.length,0);assert.equal(s.pulses.length,0);
    assert.ok(s.sounds.length>=1&&s.sounds.length<s.contacts.length,`fewer thuds than contacts: ${s.sounds.length} of ${s.contacts.length}`);
    for(let i=1;i<s.sounds.length;i++)assert.ok(s.sounds[i].time-s.sounds[i-1].time>=.06-1e-9,'one thud per 60 ms for the same two bodies');
    assert.ok(s.sounds[0].materials.includes('wood')&&s.sounds[0].materials.includes('stone'));
    assert.ok(s.decals.count()>=1&&s.particles.stats().byKind.chips>0);
  } finally { s.dispose(); }
});

test('a bare hand punching the wall is felt (no held thing), with dust from the soft hit and a thump',()=>{
  const s=setup([record('wall','physics wall',[0,0,-1.2],{data:WALL})]);
  try {
    s.tick(30,{right:{p:new THREE.Vector3(0,1.4,-.6),q:new THREE.Quaternion()}});
    assert.equal(s.hits.length,0);
    s.tick(60,{right:{p:new THREE.Vector3(0,1.4,-1.3),q:new THREE.Quaternion()}});
    assert.ok(s.hits.length>=1,'the punch is felt');
    const hit=s.hits[0];
    assert.equal(hit.hand,'right');assert.equal(hit.id,null);
    assert.ok(hit.intensity>.5&&Math.abs(hit.point.z-FACE)<.03,`punch ${hit.intensity.toFixed(2)} at z ${hit.point.z.toFixed(3)}`);
    assert.deepEqual([...hit.materials].sort(),['soft','stone']);
    assert.equal(s.sounds.length,1);assert.ok(s.particles.stats().byKind.dust>0);
  } finally { s.dispose(); }
});

test('two hands on one held thing both feel its hit; a hand still pulling something in feels nothing through it',()=>{
  const s=setup([record('sword','sword',[.04,1.1,0],{data:flat}),record('wall','physics wall',[0,0,-1.2],{data:WALL})]);
  try {
    armSword(s);
    const core=s.physics.core,b=s.physics.entries.get('sword').body;
    // Left hand onto the blade, 0.5 m out along the sword.
    const left={p:new THREE.Vector3(0,1.4,-.6),q:new THREE.Quaternion()};
    s.tick(30,{right:raised(),left});
    assert.equal(core.grab('left','sword'),true,'second hand takes hold');
    s.tick(30,{right:raised(),left});
    const wall=s.physics.entries.get('wall').body.collider(0).handle;
    const synthetic=(impulse,t)=>s.physics.bus.emit('contact',{point:{x:0,y:1.4,z:FACE},normal:{x:0,y:0,z:1},impulse,relVelocity:{x:0,y:0,z:-2},materials:['plastic','stone'],colliders:[b.collider(0).handle,wall],time:t});
    const before=s.hits.length;
    synthetic(5,100);
    const both=s.hits.slice(before);
    assert.deepEqual(both.map(h=>h.hand).sort(),['left','right'],'both holding hands feel the hit');
    assert.ok(both.every(h=>h.id==='sword'));
    assert.deepEqual(s.fx.handsOn([wall,b.collider(0).handle]).sort(),['left','right']);
    // Let go with both, move the left 2 m away and start a distance pull: no joint yet, so no feel through the sword.
    core.release('left');core.release('right');
    s.tick(30,{right:raised(),left:{p:new THREE.Vector3(0,1.4,2),q:new THREE.Quaternion()}});
    const p=b.translation();
    assert.equal(core.pull('left','sword',{x:p.x,y:p.y,z:p.z}),true);
    assert.equal(core.hands.get('left').id,'sword');assert.equal(core.hands.get('left').joint,null);
    const n=s.hits.length;
    synthetic(5,200);
    assert.equal(s.hits.length,n,'a pulling hand feels nothing through what it has not reached');
    assert.deepEqual(s.fx.handsOn([wall,b.collider(0).handle]),[]);
  } finally { s.dispose(); }
});

test('gates: a harder hit inside the pulse window replaces the pulse, a softer one is skipped; one sound per body pair per 60 ms',()=>{
  const bus=createBus();
  const core={hands:new Map([['right',{body:{collider:()=>({handle:7})},joint:null,id:null}]]),props:new Map(),
    world:{getCollider:h=>({parent:()=>({handle:h<10?1:h<25?2:3})})}};
  const pulses=[],sounds=[];
  const fx=createHitEffects({bus,core,sfx:{hit:(p,o)=>sounds.push(o.impulse)},haptic:(hand,intensity,ms)=>{pulses.push({hand,intensity,ms});return true;}});
  const contact=(impulse,time,colliders=[7,20])=>bus.emit('contact',{point:{x:0,y:0,z:0},normal:{x:0,y:1,z:0},impulse,relVelocity:{x:0,y:0,z:0},materials:['soft','stone'],colliders,time});
  contact(2,0);
  contact(1,.02);     // softer, inside the window: skipped (pulse and sound)
  contact(10,.03);    // harder, inside the window: replaces the pulse; same bodies: no second sound
  contact(1,.1);      // window over: a new pulse and sound
  contact(1,.11,[7,30]); // another body pair 10 ms later, no harder: the hand keeps its one pulse, the new pair gets its own sound
  contact(.01,.5);    // below both thresholds
  contact(1,.6,[20,30]); // no hand involved: sound only
  assert.deepEqual(pulses.map(p=>p.intensity),[hapticFor(2).intensity,hapticFor(10).intensity,hapticFor(1).intensity]);
  assert.ok(pulses.every(p=>p.hand==='right'));
  assert.deepEqual(sounds,[2,1,1,1]);
  const st=fx.stats();
  assert.equal(st.contacts,7);assert.equal(st.pulses,3);assert.equal(st.sounds,4);
  assert.equal(st.last.impulse,1);assert.equal(st.last.sent,true);
  assert.equal(bus.emit('contact',null),1,'a null contact is ignored, not an exception');
  fx.dispose();
  contact(5,1);
  assert.equal(pulses.length,3,'disposed: nothing more');
});

test('Sfx.hit is a quiet no-op without Web Audio and accepts any materials',()=>{
  const sfx=new Sfx();
  assert.equal(sfx.hit({x:0,y:0,z:0},{impulse:3,materials:['metal','stone']}),undefined);
  assert.equal(sfx.hit(null),undefined);
  assert.equal(sfx.hit({x:1,y:1,z:1},{impulse:NaN,materials:null}),undefined);
  assert.equal(typeof Sfx.prototype.hit,'function');
});
