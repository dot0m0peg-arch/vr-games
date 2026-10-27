import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.min.js';
import { Room } from '../js/room.js';
import { SceneObjects } from '../js/world/objects.js';
import * as build from '../js/parts/build/index.js';
import { Interact } from '../js/play/interact.js';
import { PhysicsRoom, initPhysics } from '../js/physics/sync.js';
await initPhysics();
build.setPhysicsColliders(true);
const record=(id,part,p,extra={})=>({id,part,p,ry:0,s:1,label:part,...extra});
function setup(records) {
  const scene=new THREE.Scene(),room=new Room(),ops=[];
  const objects=new SceneObjects({scene,room,build});
  const send=op=>{ops.push(op);room.apply(op,{local:true});};
  const physics=new PhysicsRoom({objects,room,send});
  room.load({objects:Object.fromEntries(records.map(r=>[r.id,r])),order:records.map(r=>r.id),env:{time:'day'}});
  physics.sync();
  const interact=new Interact({objects,room,send,getUser:()=> 'local',metaOf:build.metaOfRecord});
  const tick=(n,dt=1/90)=>{for(let i=0;i<n;i++){objects.update(dt,i*dt);physics.update(dt);}};
  return {scene,room,objects,physics,interact,ops,send,tick,dispose(){physics.dispose();objects.dispose();}};
}
const pose=(x,y,z)=>({p:new THREE.Vector3(x,y,z),q:new THREE.Quaternion()});

test('normal room crate records fall, stack and emit real contact points on the shared bus',()=>{
  const s=setup([record('lower','crate',[0,.4,0]),record('upper','crate',[0,1.6,0])]);
  try {
    const contacts=[];s.physics.bus.on('contact',e=>contacts.push(e));
    s.tick(900);
    const a=s.objects.bounds('lower'),b=s.objects.bounds('upper');
    assert.ok(Math.abs(a.min.y)<.015,`crate rests on floor: ${a.min.y}`);
    assert.ok(Math.abs(b.min.y-a.max.y)<.02,`stacked, not snapped or interpenetrating: ${b.min.y-a.max.y}`);
    assert.ok(contacts.some(e=>e.impulse>0&&Math.abs(e.point.y)<.05),'actual floor impact drives the same VFX bus');
    assert.ok(s.physics.entries.get('lower').body.isDynamic());
    assert.ok(!s.objects.entries.get('lower').fly,'no scripted flight');
  }finally{s.dispose();}
});

test('compound colliders preserve space below an actual table rather than sealing its whole bounds',()=>{
  const s=setup([record('table','card table',[0,0,0]),record('ball','ball',[0,.3,0])]);
  try {
    assert.ok(s.physics.entries.get('table').body.numColliders()>1);
    s.tick(270);
    assert.ok(s.objects.bounds('ball').max.y<.4,'ball fits below the tabletop');
    assert.ok(Math.abs(s.objects.bounds('ball').min.y)<.02);
  }finally{s.dispose();}
});

test('Interact grabs a dynamic ball with a joint; a tracked hand cannot carry it through a thin wall',()=>{
  const wall={blueprint:{name:'wall',size:[.05,4,4],parts:[{shape:'box',p:[0,2,0],s:[.05,4,4],mat:'stone',color:'#888888'}]}};
  const s=setup([record('ball','ball',[0,1,0]),record('wall','wall',[.5,0,0],{data:wall})]);
  try {
    const hand=pose(0,1.1,0);s.physics.setHands({right:hand});
    assert.equal(s.interact.grab('right',{point:hand.p,quat:hand.q}),'ball');
    assert.ok(s.physics.core.hands.get('right').joint);
    assert.ok(s.physics.entries.get('ball').body.isDynamic(),'held objects remain dynamic');
    s.physics.setHands({right:pose(2,1.1,0)});s.tick(180);
    const h=s.physics.core.hands.get('right');
    assert.ok(h.body.translation().x<.51,`physics hand stopped: ${h.body.translation().x}`);
    assert.ok(s.objects.bounds('ball').max.x<.52,`held ball stopped at wall: ${s.objects.bounds('ball').max.x}`);
    assert.ok(h.target.p.x-h.body.translation().x>1,'tracking target remains separate from constrained hand');
  }finally{s.dispose();}
});

test('release keeps simulated spin/velocity and retires attach, surface snap and fly for physics records',()=>{
  const s=setup([record('ball','ball',[0,1,0])]);
  try {
    const hand=pose(0,1.1,0);s.physics.setHands({right:hand});
    assert.equal(s.interact.grab('right',{point:hand.p,quat:hand.q}),'ball');
    const b=s.physics.entries.get('ball').body;
    b.setLinvel({x:3,y:2,z:0},true);b.setAngvel({x:0,y:4,z:0},true);
    assert.equal(s.interact.release('right',{velocity:[25,25,0]}),'ball');
    assert.equal(s.physics.core.hands.get('right').joint,null);
    assert.ok(Math.abs(b.linvel().x-3)<1e-6);assert.ok(Math.abs(b.angvel().y-4)<1e-6);
    assert.equal(s.room.get('ball').attach,undefined);
    assert.ok(!s.ops.at(-1).fly);assert.ok(!s.room.get('ball').onto);
    s.tick(9);assert.ok(b.translation().x>.2,'released object actually travels');
  }finally{s.dispose();}
});

test('scale, room reload and delete replace/remove bodies without leaving invisible colliders',()=>{
  const s=setup([record('ball','ball',[0,1,0])]);
  try {
    const first=s.physics.entries.get('ball').body;
    s.send({t:'set',id:'ball',patch:{s:2}});s.physics.sync();
    assert.ok(!first.isValid());
    const second=s.physics.entries.get('ball').body;
    const q=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),.6);
    second.setRotation(q,true);second.setLinvel({x:0,y:0,z:0},true);
    s.physics.commitRelease('ball');
    const saved=s.room.snapshot();s.room.load(saved);s.physics.sync();
    assert.ok(Math.abs(s.physics.entries.get('ball').body.rotation().x-q.x)<1e-5,'full rotation survives saved room reload');
    s.send({t:'del',ids:['ball']});s.physics.sync();
    assert.equal(s.physics.entries.size,0);assert.equal(s.physics.core.props.size,1,'only the permanent floor remains');
  }finally{s.dispose();}
});

test('90 Hz physics produces the same falling pose at different render rates and caps a suspended frame',()=>{
  const a=setup([record('ball','ball',[0,4,0])]),b=setup([record('ball','ball',[0,4,0])]);
  try {
    a.tick(90);b.tick(45,1/45);
    const pa=a.physics.entries.get('ball').body.translation(),pb=b.physics.entries.get('ball').body.translation();
    assert.ok(Math.abs(pa.y-pb.y)<1e-5);
    const steps=a.physics.core.stats().steps;a.physics.update(20);
    assert.equal(a.physics.core.stats().steps-steps,4,'never catches up with unbounded work after a pause');
  }finally{a.dispose();b.dispose();}
});
