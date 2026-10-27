// Reusable Rapier world/hand mechanics. Rendering and room ownership stay with the game.
// Codex (Command), Oct 25 2026. Rapier 0.21.0 is injected, never downloaded at runtime.
import { createContactBridge } from './contacts.js';

const v = (x=0,y=0,z=0) => ({x,y,z});
const limit = (a, max) => { const n=Math.hypot(a.x,a.y,a.z); return n>max ? v(a.x*max/n,a.y*max/n,a.z*max/n) : a; };
const rotate=(a,q)=>{const tx=2*(q.y*a.z-q.z*a.y),ty=2*(q.z*a.x-q.x*a.z),tz=2*(q.x*a.y-q.y*a.x);return v(a.x+q.w*tx+q.y*tz-q.z*ty,a.y+q.w*ty+q.z*tx-q.x*tz,a.z+q.w*tz+q.x*ty-q.y*tx);};
const inverse=q=>({x:-q.x,y:-q.y,z:-q.z,w:q.w});
const mul=(a,b)=>({x:a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,y:a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,z:a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w,w:a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z});
const norm=a=>Math.hypot(a.x,a.y,a.z), scale=(a,k)=>v(a.x*k,a.y*k,a.z*k);
const plus=(a,b)=>v(a.x+b.x,a.y+b.y,a.z+b.z), sub=(a,b)=>v(a.x-b.x,a.y-b.y,a.z-b.z);
const cross=(a,b)=>v(a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x), dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
const unit=q=>{const n=Math.hypot(q.x,q.y,q.z,q.w)||1;return {x:q.x/n,y:q.y/n,z:q.z/n,w:q.w/n};};
const angleBetween=(a,b)=>2*Math.acos(Math.min(1,Math.abs(a.x*b.x+a.y*b.y+a.z*b.z+a.w*b.w)));
const slerp=(a,b,t)=>{let d=a.x*b.x+a.y*b.y+a.z*b.z+a.w*b.w;if(d<0){b={x:-b.x,y:-b.y,z:-b.z,w:-b.w};d=-d;}
  if(d>.9995)return unit({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t,w:a.w+(b.w-a.w)*t});
  const th=Math.acos(d),s=Math.sin(th),wa=Math.sin((1-t)*th)/s,wb=Math.sin(t*th)/s;
  return {x:a.x*wa+b.x*wb,y:a.y*wa+b.y*wb,z:a.z*wa+b.z*wb,w:a.w*wa+b.w*wb};};
const IDENTITY={x:0,y:0,z:0,w:1};
// Grip alignment ramps: a handle turns into the fist at no more than this, through the joint (so mass and inertia count).
const ALIGN_SPEED=.8, ALIGN_SPIN=9, ALIGN_MIN=.15, ALIGN_MAX=.5; // m/s, rad/s, s, s
export const PHYSICS_MATERIALS = {
  wood: [600,.5,.2], metal: [7800,.4,.1], gold: [7800,.4,.1], stone: [2500,.7,.05],
  rubber: [1100,.9,.75], plastic: [950,.4,.3], fabric: [300,.6,0], glass: [2500,.3,.2],
  matte: [600,.5,.15], flesh: [1000,.6,.05],
};
// Collision layers (Rapier interaction groups: membership << 16 | filter). A held thing never collides with the hand
// holding it, so the palm sitting inside a grabbed ball is not a contact the solver keeps fighting the grab joint over.
export const LAYERS = { STATIC: 1, PROP: 2, HAND_L: 4, HAND_R: 8, HELD: 16, ALL: 0xffff };
export const groupsOf = (membership, filter = LAYERS.ALL) => ((membership & 0xffff) << 16) | (filter & 0xffff);
export function createPhysicsWorld(R, bus) {
  const world = new R.World(v(0,-9.81,0));
  world.timestep=1/90;
  world.integrationParameters.numSolverIterations=8;
  const contacts=createContactBridge(R,world,bus);
  const hands=new Map(), props=new Map(), mounts=new Map();
  const dt=1/90;
  let accumulator=0, steps=0;
  function remove(id) {
    const e=props.get(id); if(!e) return;
    for(const m of [...mounts.values()]) if(m.id===id||m.onId===id) unmount(m.id);
    for(const st of [...sticks.values()]) if(st.id===id||st.onId===id) unstick(st.id);
    for(const [name,h] of hands) if(h.id===id) release(name);
    for(let i=0;i<e.body.numColliders();i++) contacts.forget(e.body.collider(i));
    world.removeRigidBody(e.body); props.delete(id);
  }
  // Shapes are body-local with their scale already applied. Compound colliders retain gaps. edges (optional): the
  // body's biting edges, body-local and scaled, [{p:{x,y,z}, dir:{x,y,z} unit, r}] (see stick below).
  function add(id,{p,q={x:0,y:0,z:0,w:1},fixed=false,shapes,edges=[]}) {
    remove(id);
    const desc=(fixed?R.RigidBodyDesc.fixed():R.RigidBodyDesc.dynamic())
      .setTranslation(p.x,p.y,p.z).setRotation(q).setCcdEnabled(!fixed);
    const body=world.createRigidBody(desc);
    let rawMass=0;
    const colliders=[];
    for(const s of shapes) {
      const [density,friction,restitution]=PHYSICS_MATERIALS[s.material]??PHYSICS_MATERIALS.matte;
      const d=s.shape==='ball'?R.ColliderDesc.ball(s.size.x/2):R.ColliderDesc.cuboid(s.size.x/2,s.size.y/2,s.size.z/2);
      const volume=s.shape==='ball'?Math.PI*s.size.x**3/6:s.size.x*s.size.y*s.size.z;
      const mass=volume*density*(s.hollow?.25:1);
      rawMass+=mass;
      d.setTranslation(s.p.x,s.p.y,s.p.z).setRotation(s.q??{x:0,y:0,z:0,w:1}).setMass(mass)
        .setFriction(friction).setRestitution(restitution).setCollisionGroups(groupsOf(fixed?LAYERS.STATIC:LAYERS.PROP));
      const c=world.createCollider(d,body);
      contacts.register(c,s.material==='fabric'?'soft':s.material,undefined,s.surface??s.material);
      colliders.push({c,mass});
    }
    // Clamp the complete object, not every little decorative collider independently.
    if(!fixed&&rawMass>0) {
      const scale=Math.min(500,Math.max(.05,rawMass))/rawMass;
      for(const {c,mass} of colliders) c.setMass(mass*scale);
      body.recomputeMassPropertiesFromColliders();
    }
    const pose={p:{...body.translation()},q:{...body.rotation()}};
    props.set(id,{body,fixed,previous:pose,kinematic:false,follow:null,edges:Array.isArray(edges)?edges.filter(e=>e?.p&&e.dir&&e.r>0):[]});
    return body;
  }
  // Ownership (several devices in one room): a body another device simulates is kinematic here. It still collides with
  // the local hands and reports contacts, but nothing here pushes it; it moves to the poses that device streams
  // (follow). Turning it dynamic again starts it with the given velocity, so a handover keeps its motion.
  function setKinematic(id,on,{linvel=null,angvel=null}={}) {
    const e=props.get(id); if(!e||e.fixed) return false;
    on=!!on;
    if(e.kinematic===on) return true;
    e.kinematic=on;
    if(on) {
      for(const [name,h] of hands) if(h.id===id) release(name); // nothing here holds or pulls what another device simulates
      unstick(id); // a follower has no joints of its own: the owner's stream carries where it sits
      e.body.setBodyType(R.RigidBodyType.KinematicPositionBased,true);
      e.body.setLinvel(v(),true);e.body.setAngvel(v(),true);
    } else {
      e.follow=null;
      e.body.setBodyType(R.RigidBodyType.Dynamic,true);
      if(linvel&&[linvel.x,linvel.y,linvel.z].every(Number.isFinite)) e.body.setLinvel(linvel,true);
      if(angvel&&[angvel.x,angvel.y,angvel.z].every(Number.isFinite)) e.body.setAngvel(angvel,true);
      e.body.wakeUp();
    }
    return true;
  }
  // Where a kinematic body should be (the owner's latest streamed pose, world). Each step moves it a good way toward
  // that pose, extrapolated by the velocity between the last two poses, so a 15 Hz stream reads as smooth motion
  // without a packet of lag. Returns the velocity estimate (what a handover starts with).
  const FOLLOW_RATE=20, FOLLOW_AHEAD=.15;
  function follow(id,pose) {
    const e=props.get(id); if(!e||e.fixed||!pose?.p||!pose.q) return null;
    const p={x:+pose.p.x,y:+pose.p.y,z:+pose.p.z},q=unit({x:+pose.q.x,y:+pose.q.y,z:+pose.q.z,w:+pose.q.w});
    if(![p.x,p.y,p.z,q.x,q.y,q.z,q.w].every(Number.isFinite)) return null;
    const now=contacts.stats().time,prev=e.follow;
    let vel=v();
    if(prev&&now-prev.at>1e-3&&now-prev.at<1) vel=limit(scale(sub(p,prev.p),1/(now-prev.at)),30);
    e.follow={p,q,at:now,vel};
    return vel;
  }
  function driveFollow(e) {
    const f=e.follow; if(!f||!e.kinematic) return;
    const ahead=Math.min(FOLLOW_AHEAD,Math.max(0,contacts.stats().time-f.at));
    const want=plus(f.p,scale(f.vel,ahead));
    const cur=e.body.translation(),cq=e.body.rotation(),k=Math.min(1,dt*FOLLOW_RATE);
    const np=plus(cur,scale(sub(want,cur),k));
    e.body.setNextKinematicTranslation(np);
    e.body.setNextKinematicRotation(slerp(cq,f.q,k));
  }
  function targetHand(name,pose) {
    if(!pose?.p||!pose.q||![pose.p.x,pose.p.y,pose.p.z,pose.q.x,pose.q.y,pose.q.z,pose.q.w].every(Number.isFinite)) { if(hands.has(name)) release(name); const h=hands.get(name); if(h){contacts.forget(h.body.collider(0));world.removeRigidBody(h.body);hands.delete(name);} return; }
    let h=hands.get(name);
    if(!h) {
      const b=world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(pose.p.x,pose.p.y,pose.p.z)
        .setRotation(pose.q).setGravityScale(0).setCcdEnabled(true));
      const bit=name==='left'?LAYERS.HAND_L:LAYERS.HAND_R;
      contacts.register(world.createCollider(R.ColliderDesc.cuboid(.045,.025,.055).setMass(1).setFriction(.7).setCollisionGroups(groupsOf(bit)),b),'soft',undefined,'hand');
      h={body:b,target:null,joint:null,id:null,pull:null,bit}; hands.set(name,h);
    }
    // Read through accessors: spreading a THREE.Quaternion copies _x/_y/_z/_w and the drive goes NaN.
    h.target={p:{x:pose.p.x,y:pose.p.y,z:pose.p.z},q:{x:pose.q.x,y:pose.q.y,z:pose.q.z,w:pose.q.w}};
  }
  // The hold joint: joint frame = the hand frame itself (anchor 0, identity); on the object, `anchor` is the body-local point
  // that sits in the palm and `frame` the body-local rotation that lines up with the hand (body.rot * frame == hand.rot).
  function setJoint(h,e,{anchor,frame}) {
    if(h.joint)world.removeImpulseJoint(h.joint,false);
    h.joint=world.createImpulseJoint(R.JointData.fixed(v(),IDENTITY,anchor,frame),h.body,e.body,true);
    h.joint.setContactsEnabled(false);
    h.frame={anchor,frame};
  }
  // Rigid poses {p,q}: compose (A then B in A's frame) and invert.
  const compose=(A,B)=>({p:plus(A.p,rotate(B.p,A.q)),q:unit(mul(A.q,B.q))});
  const invPose=A=>{const q=inverse(A.q);return {p:rotate(scale(A.p,-1),q),q};};
  // The hand's controller pose, in the held body's local frame (what the hold joint would be if the hand sat on it).
  function controllerPose(h,e) {
    const bp=e.body.translation(),inv=inverse(e.body.rotation()),t=h.target;
    return {anchor:rotate(v(t.p.x-bp.x,t.p.y-bp.y,t.p.z-bp.z),inv),frame:unit(mul(inv,t.q))};
  }
  // Second hand: the joint frame that puts this hand on its controller WHEN the first hand sits on its own, built from the
  // first hand's joint frame (its grip target while it still ramps) and the two controllers' relative pose. Reading it off
  // the body's current pose instead would bake in whatever lag the body had behind the controllers at that moment, and two
  // fixed joints that disagree can never both be satisfied: the solver then fights the drive to an arbitrary standstill.
  function pairedPose(h,first) {
    const J1=first.align?first.align.to:first.frame;
    const r=compose({p:J1.anchor,q:J1.frame},compose(invPose(first.target),h.target));
    return {anchor:r.p,frame:r.q};
  }
  // The hands holding `id` by a joint, as a collision-group mask: a held object never collides with the hands on it.
  const holdMask=id=>{let m=0;for(const o of hands.values())if(o.id===id&&o.joint)m|=o.bit;return m;};
  const heldLayer=id=>{const m=holdMask(id);return m?groupsOf(LAYERS.HELD,LAYERS.ALL&~m):groupsOf(LAYERS.PROP);};
  // grip (optional): {anchor:{x,y,z} body-local grip point (scaled), q:{x,y,z,w} body rotation relative to the hand frame}.
  // Without one the object is held exactly where it was touched. With one the joint frame eases from the touched pose to
  // the grip pose (handle in the palm, head along the fist) over a short ramp, so the object turns into the hand through the
  // solver: a heavy hammer realigns slower and drags the hand, a dagger snaps round. Never a teleport.
  // Two hands: a second hand on an object the other hand already holds gets its own fixed joint where it touched (a hand
  // on the blade, the far end of a plank); the first grip is not realigned. Either hand can let go and the other keeps it.
  function grab(name,id,grip=null) {
    const e=props.get(id),h=hands.get(name);
    if(!e||e.fixed||e.kinematic||!h||h.joint) return false; // another device's body is claimed first (sync.js), never held
    if(h.id&&h.id!==id) return false; // this hand is pulling something else in
    const partners=[...hands.values()].filter(other=>other!==h&&other.id===id);
    if(partners.some(other=>!other.joint)) return false; // the other hand is still pulling it in: let that finish first
    const second=partners.length>0;
    const bp=e.body.translation(),bq=e.body.rotation(),hp=h.body.translation(),hq=h.body.rotation();
    // Exact existing world pose: no object teleport on grab. Transform palm into body-local frame.
    const inv=inverse(bq);
    const from={anchor:rotate(v(hp.x-bp.x,hp.y-bp.y,hp.z-bp.z),inv),frame:unit(mul(inv,hq))};
    h.align=null;
    const ramp=to=>{const dur=Math.min(ALIGN_MAX,Math.max(ALIGN_MIN,norm(sub(to.anchor,from.anchor))/ALIGN_SPEED,angleBetween(from.frame,to.frame)/ALIGN_SPIN));h.align={from,to,t:0,dur};};
    if(!second&&grip?.anchor&&grip.q&&[grip.anchor.x,grip.anchor.y,grip.anchor.z,grip.q.x,grip.q.y,grip.q.z,grip.q.w].every(Number.isFinite)) {
      ramp({anchor:v(grip.anchor.x,grip.anchor.y,grip.anchor.z),frame:unit(inverse(grip.q))});
    } else if(second&&h.target&&partners[0].target) {
      // A free hand pressed against a held thing sits off its controller (the contact pushed it), and the thing may lag
      // behind or still be turning into the first hand's grip. Locking the touched pose in would lock in a mismatch the
      // joints and the drive then fight over for ever. Instead the second joint eases from the touched pose to the pose
      // paired with the first hand's joint (re-read every step while both hands may still be closing or moving), and
      // lasts at least as long as the first hand's ramp, so when it ends both hands sit on their controllers.
      const first=partners[0];
      ramp(pairedPose(h,first));
      h.align.track=first;
      if(first.align) h.align.dur=Math.max(h.align.dur,first.align.dur-first.align.t);
    }
    setJoint(h,e,from);
    h.id=id; h.pull=null; h.wantGrip=null; e.body.wakeUp();
    setLayer(e.body,heldLayer(id)); // held: collides with everything but the hand(s) on it
    return true;
  }
  // Each step of an alignment moves the joint frame a little further toward the grip pose (ease in and out).
  function driveAlign(h) {
    const a=h.align; if(!a)return;
    const e=props.get(h.id); if(!e||!h.joint){h.align=null;return;}
    if(a.track&&h.target) a.to=(a.track.joint&&a.track.id===h.id&&a.track.target)?pairedPose(h,a.track):controllerPose(h,e);
    a.t=Math.min(a.dur,a.t+dt);
    const u=a.t/a.dur,s=u*u*(3-2*u);
    const pose=u>=1?a.to:{anchor:plus(a.from.anchor,scale(sub(a.to.anchor,a.from.anchor),s)),frame:slerp(a.from.frame,a.to.frame,s)};
    setJoint(h,e,pose);
    if(u>=1)h.align=null;
  }
  function setLayer(body,g){for(let i=0;i<body.numColliders();i++)body.collider(i).setCollisionGroups(g);}
  // grip: same as grab(); applied when the pulled object arrives in the hand.
  function pull(name,id,point,grip=null) {
    const e=props.get(id),h=hands.get(name);
    if(!e||e.fixed||e.kinematic||!h||h.id||[...hands.values()].some(other=>other.id===id))return false;
    const p=e.body.translation();
    const anchor=rotate(v(point.x-p.x,point.y-p.y,point.z-p.z),inverse(e.body.rotation()));
    h.id=id;h.pull={anchor,time:0};h.wantGrip=grip;e.body.wakeUp();return true;
  }
  function release(name) {
    const h=hands.get(name); if(!h?.id)return null;
    const id=h.id;
    // The other hand may still hold it: then it stays HELD (minus the hand that let go), else it is a free prop again.
    if(h.joint){world.removeImpulseJoint(h.joint,true);h.joint=null;const e=props.get(id);if(e)setLayer(e.body,heldLayer(id));}
    h.joint=null;h.id=null;h.pull=null;h.align=null;h.wantGrip=null;
    // The palm sits inside what it held: let the object leave before the hand collides again.
    h.body.collider(0).setCollisionGroups(0);h.ghost=.2;
    // Keep simulated linear AND angular velocity. No ballistic records or hand-velocity overwrite.
    return id;
  }
  function drivePull(name,h) {
    if(!h.pull)return;
    const e=props.get(h.id);
    h.pull.time+=dt;
    if(!e||h.pull.time>8){release(name);return;}
    const p=e.body.translation(),hp=h.body.translation();
    const a=rotate(h.pull.anchor,e.body.rotation());
    const delta=v(hp.x-p.x-a.x,hp.y-p.y-a.y,hp.z-p.z-a.z);
    // A bounded impulse changes velocity; CCD and the solver still decide where it can go.
    if(Math.hypot(delta.x,delta.y,delta.z)<.14){grab(name,h.id,h.wantGrip);return;}
    const wanted=limit(v(delta.x*8,delta.y*8,delta.z*8),6),vel=e.body.linvel(),mass=e.body.mass();
    const hv=h.body.linvel();
    e.body.applyImpulse(limit(v((wanted.x+hv.x-vel.x)*mass*.35,(wanted.y+hv.y-vel.y+9.81*dt)*mass*.35,(wanted.z+hv.z-vel.z)*mass*.35),350*dt),true);
  }
  // Angular impulse that gives body b the rotation change dw (world frame) through its own anisotropic inertia.
  const spin=(b,dw)=>{const frame=mul(b.rotation(),b.principalInertiaLocalFrame()),I=b.principalInertia();const l=rotate(dw,inverse(frame));return rotate(v(l.x*I.x,l.y*I.y,l.z*I.z),frame);};
  const FORCE=350, TORQUE=25; // what the hand can exert: heavy things lag, sink and resist turning
  // Shortest-arc rotation (axis times angle) taking rotation q to rotation a.
  const rotVec=(a,q)=>{const err=mul(a,inverse(q));const sign=err.w<0?-1:1,sn=Math.hypot(err.x,err.y,err.z);if(sn<1e-9)return v();return scale(v(sign*err.x,sign*err.y,sign*err.z),2*Math.atan2(sn,Math.abs(err.w))/sn);};
  function drive(h) {
    const held=h.joint&&props.get(h.id)?.body;
    const partners=held?[...hands.values()].filter(o=>o!==h&&o.joint&&o.id===h.id):[];
    if(partners.length) return driveAssembly([h,...partners],held);
    const p=h.body.translation(),q=h.body.rotation(),t=h.target,vel=h.body.linvel(),av=h.body.angvel();
    // The hand and what its joint carries move as ONE rigid assembly: every body gets the same velocity
    // change, so the drive never has to pass through the joint. Sizing the impulse for hand plus load but
    // applying it to the hand alone made the joint drag the load along a step late and swing it (8 rad/s).
    const bodies=held?[h.body,held]:[h.body];
    let M=0; for(const b of bodies) M+=b.mass();
    // Linear: toward the controller, never faster than the capped force can stop in time (no bang-bang).
    const e=v(t.p.x-p.x,t.p.y-p.y,t.p.z-p.z),en=norm(e);
    const vmax=Math.min(12,Math.sqrt(2*(FORCE/M)*.5*en));
    const wanted=limit(v(e.x*.9/dt,e.y*.9/dt,e.z*.9/dt),vmax);
    const dv=v(wanted.x-vel.x,wanted.y-vel.y,wanted.z-vel.z);
    // The hand holds up what it carries: its weight counts against the same force cap.
    const carry=held?held.mass()*held.gravityScale()*9.81*dt:0;
    const k=Math.min(1,FORCE*dt/Math.max(1e-9,norm(v(dv.x*M,dv.y*M+carry,dv.z*M))));
    for(const b of bodies) b.applyImpulse(scale(dv,b.mass()*k),true);
    if(held) held.applyImpulse(v(0,carry*k,0),true);
    // Angular: rotate the assembly about the palm. Quaternion target * inverse(actual), shortest arc.
    const a=t.q,b={x:-q.x,y:-q.y,z:-q.z,w:q.w};
    const err={x:a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,y:a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,z:a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w,w:a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z};
    const sign=err.w<0?-1:1,sn=Math.hypot(err.x,err.y,err.z);
    const axis=sn>1e-9?scale(v(sign*err.x,sign*err.y,sign*err.z),1/sn):v(0,1,0),theta=2*Math.atan2(sn,Math.abs(err.w));
    // Angular impulse about the palm for a unit rotation change = the assembly's inertia along this axis.
    const about=dw=>bodies.map(b=>{const r=sub(b.worldCom(),p),lin=scale(cross(dw,r),b.mass());return {b,torque:spin(b,dw),lin,L:plus(spin(b,dw),cross(r,lin))};});
    let Ieff=0; for(const {L} of about(axis)) Ieff+=norm(L);
    const wmax=Math.min(40,Math.sqrt((TORQUE/Math.max(Ieff,1e-6))*theta));
    const omega=scale(axis,Math.min(theta*.9/dt,wmax));
    const parts=about(v(omega.x-av.x,omega.y-av.y,omega.z-av.z));
    let L=v(); for(const part of parts) L=plus(L,part.L);
    const kk=Math.min(1,TORQUE*dt/Math.max(1e-9,norm(L)));
    for(const {b:body,torque,lin} of parts){body.applyTorqueImpulse(scale(torque,kk),true);body.applyImpulse(scale(lin,kk),true);}
  }
  // Two hands on one object: both hands and the object are one rigid assembly, driven ONCE per step by one controller
  // toward the best fit of both controllers (average palm error; rotation = the hands' own turning errors plus, counted
  // twice, the turn that lines the palm-to-palm line up with the controllers), about the point between the palms, with
  // the hands' force and torque added up. Two separate drives each pulling toward their own controller saturated at a
  // degree of disagreement and fought to an arbitrary standstill (one hand 16 cm off); one shared drive splits any
  // disagreement evenly and two hands lift and turn more than one.
  function driveAssembly(hs,held) {
    const n=hs.length,bodies=[...hs.map(o=>o.body),held];
    let M=0; for(const b of bodies) M+=b.mass();
    const F=FORCE*n,T=TORQUE*n;
    let e=v(),vel=v(),pivot=v();
    for(const o of hs){const p=o.body.translation();e=plus(e,sub(o.target.p,p));vel=plus(vel,o.body.linvel());pivot=plus(pivot,p);}
    e=scale(e,1/n);vel=scale(vel,1/n);pivot=scale(pivot,1/n);
    const en=norm(e);
    const vmax=Math.min(12,Math.sqrt(2*(F/M)*.5*en));
    const wanted=limit(scale(e,.9/dt),vmax);
    const dv=sub(wanted,vel);
    const carry=held.mass()*held.gravityScale()*9.81*dt;
    const k=Math.min(1,F*dt/Math.max(1e-9,norm(v(dv.x*M,dv.y*M+carry,dv.z*M))));
    for(const b of bodies) b.applyImpulse(scale(dv,b.mass()*k),true);
    held.applyImpulse(v(0,carry*k,0),true);
    const errs=hs.map(o=>rotVec(o.target.q,o.body.rotation()));
    if(n===2) {
      const da=sub(hs[1].body.translation(),hs[0].body.translation()),dtg=sub(hs[1].target.p,hs[0].target.p);
      const c=cross(da,dtg),s=norm(c);
      if(s>1e-9){const line=scale(c,Math.atan2(s,dot(da,dtg))/s);errs.push(line,line);}
    }
    let rv=v(); for(const r of errs) rv=plus(rv,r); rv=scale(rv,1/errs.length);
    const theta=norm(rv),axis=theta>1e-9?scale(rv,1/theta):v(0,1,0),av=held.angvel();
    const about=dw=>bodies.map(b=>{const r=sub(b.worldCom(),pivot),lin=scale(cross(dw,r),b.mass());return {b,torque:spin(b,dw),lin,L:plus(spin(b,dw),cross(r,lin))};});
    let Ieff=0; for(const {L} of about(axis)) Ieff+=norm(L);
    const wmax=Math.min(40,Math.sqrt((T/Math.max(Ieff,1e-6))*theta));
    const omega=scale(axis,Math.min(theta*.9/dt,wmax));
    const parts=about(sub(omega,av));
    let L=v(); for(const part of parts) L=plus(L,part.L);
    const kk=Math.min(1,T*dt/Math.max(1e-9,norm(L)));
    for(const {b:body,torque,lin} of parts){body.applyTorqueImpulse(scale(torque,kk),true);body.applyImpulse(scale(lin,kk),true);}
  }
  // Mounts: a prop hung on another by a ball joint at `anchor` (world), with a spring that turns it back to the pose it
  // was mounted in, so a struck thing rocks and settles instead of toppling or standing rigid (a straw dummy on its
  // post, a sign on a pole, a lamp on a stand). The spring is sized from the mounted body's own mass and inertia about
  // the anchor: it swings at `hz` and settles with damping ratio `settle`, and it always beats the weight of a body
  // whose centre sits above the anchor. Past `breakAt` radians of tilt the joint gives (bus 'break') and the prop is
  // an ordinary free body again. Rapier's own joint motors are not used: the spring is a torque applied each step,
  // like the hand drive, so a stronger body needs a harder hit and the behaviour is the same at any time step.
  const UP=v(0,1,0);
  const tiltBetween=(a,b)=>{const ua=rotate(UP,a),ub=rotate(UP,b);return Math.acos(Math.max(-1,Math.min(1,dot(ua,ub))));};
  function mount(id,onId,{anchor,hz=.9,settle=.25,breakAt=null}={}) {
    const e=props.get(id),b=props.get(onId);
    if(!e||!b||e.fixed||id===onId||!anchor||![anchor.x,anchor.y,anchor.z].every(Number.isFinite)) return false;
    unmount(id);
    const ep=e.body.translation(),eq=e.body.rotation(),bp=b.body.translation(),bq=b.body.rotation();
    const a1=rotate(sub(anchor,bp),inverse(bq)),a2=rotate(sub(anchor,ep),inverse(eq));
    const joint=world.createImpulseJoint(R.JointData.spherical(a1,a2),b.body,e.body,true);
    joint.setContactsEnabled(false);
    const rest=unit(mul(inverse(bq),eq)); // mounted body's rotation in the base's frame
    const m=e.body.mass(),com=e.body.worldCom(),I=e.body.principalInertia();
    const r=sub(com,anchor),h=norm(r);
    const Ipiv=(I.x+I.y+I.z)/3+m*h*h;                 // about the anchor, any horizontal axis (near enough)
    const w=2*Math.PI*Math.max(.05,hz);
    const kEff=Ipiv*w*w;                                // what sets the swing rate
    const kGrav=Math.max(0,m*9.81*dot(r,UP));           // weight above the anchor tips it further: hold that too
    const k=kEff+kGrav;
    // Where it hangs at rest: a centre of mass off the anchor's vertical leans it a little for good. Rapier sleeps a slow
    // body wherever it is, so a swing that dozes off further tilted than twice that (at least 1 degree) is woken to finish.
    const tol=Math.max(.0175,2*m*9.81*norm(sub(r,scale(UP,dot(r,UP))))/k);
    const mt={id,onId,joint,rest,k,c:2*Math.max(0,settle)*Math.sqrt(Ipiv*kEff),tol,hz,settle,breakAt:breakAt>0?breakAt:null,lean:0,maxLean:0,broke:false};
    mounts.set(id,mt);e.body.wakeUp();
    return true;
  }
  function unmount(id,broke=false) {
    const mt=mounts.get(id); if(!mt) return false;
    if(mt.joint){try{world.removeImpulseJoint(mt.joint,true);}catch{}mt.joint=null;}
    mounts.delete(id);
    const e=props.get(id); if(e)e.body.wakeUp();
    if(broke){mt.broke=true;bus.emit('break',{id,onId:mt.onId,lean:mt.lean,time:contacts.stats().time});}
    return true;
  }
  function driveMount(mt) {
    const e=props.get(mt.id),b=props.get(mt.onId);
    if(!e||!b){unmount(mt.id);return;}
    const restQ=unit(mul(b.body.rotation(),mt.rest)),q=e.body.rotation();
    const tilt=tiltBetween(restQ,q);
    mt.lean=tilt; if(tilt>mt.maxLean)mt.maxLean=tilt;
    if(e.kinematic) return; // another device simulates this swing: it is followed, not sprung, and only its owner breaks it
    if(mt.breakAt&&tilt>mt.breakAt){unmount(mt.id,true);return;}
    const rv=rotVec(restQ,q),wv=sub(e.body.angvel(),b.body.angvel());
    // Rapier's sleep thresholds sit above a rocking swing's speeds and would freeze it mid-rock; it stays awake until it
    // hangs within its resting tilt and still, then sleeps where the spring holds it. A hit wakes it again.
    if(tilt>mt.tol||norm(wv)>.02) e.body.wakeUp(); else if(e.body.isSleeping()) return;
    const torque=sub(scale(rv,mt.k),scale(wv,mt.c));
    if(![torque.x,torque.y,torque.z].every(Number.isFinite)) return;
    e.body.applyTorqueImpulse(scale(torque,dt),false);
  }
  // Sticking: a weapon driven edge-first into straw or wood hard enough stays in it. A body's `edges` (part-local point,
  // bite direction, reach; js/physics/edges.js for the game's parts) say what bites. A contact counts when its point sits
  // within an edge's reach, the edge is moving into the struck body faster than BITE_SPEED and mostly along itself (a
  // thrust or a chop, not the flat of the blade), the struck material is one a blade bites (STICKY) and the impulse is
  // at least STICK_MIN. A fixed joint between the two bodies is then set with the struck-side anchor sunk `depth`
  // further along the edge (deeper the harder the hit, capped per material), so the solver pulls the blade in over a
  // few steps instead of teleporting it; contacts between the two are off while it is in. It stays put when the hand
  // lets go. A hand holding it that pulls its controller away from the stuck hand drives the capped hand force into the
  // joint: that tug adds up against `hold` (grows with depth), faster straight back out along the blade than prying
  // sideways, and past it the joint gives (bus 'unstick') and the weapon comes free with the hand; two hands tug twice as
  // fast. Bus 'stick' / 'unstick' carry what the haptics, the HUD and the room record need; stickAt re-sets a saved
  // stick (reload, handover). Owner, Oct 23 2026 (Codex transmitter): "It should do something, or it should stick. The
  // axe should stick maybe." Claude (Command), Oct 26 2026.
  const STICKY={soft:.12,wood:.05};          // struck materials a blade bites into, and the deepest it goes (m)
  const STICK_MIN=3, BITE_SPEED=1.2, BITE_ALIGN=.6, DEPTH_PER_NS=.005, DEPTH_MIN=.01; // N*s, m/s, cos, m per N*s, m
  // A hand pinned to a stuck blade gets no further than about 7 cm from its controller (the joints give that much), so
  // the tug counts in full from there; a held thing swinging normally lags its controller a centimetre or two.
  const HOLD_BASE=40, HOLD_PER_M=2000, TUG_START=.02, TUG_FULL=.07, TUG_DECAY=120;   // N*s, N*s per m, m, m, N*s per s
  const sticks=new Map();
  const holders=id=>[...hands].filter(([,h])=>h.id===id).map(([name])=>name); // hands holding or pulling in `id`
  const bodyOfHandle=h=>world.getCollider(h)?.parent()??null;
  const propOfBody=body=>{if(!body)return null;for(const [id,e] of props)if(e.body.handle===body.handle)return {id,e};return null;};
  const isHandBody=body=>{for(const h of hands.values())if(h.body.handle===body.handle)return true;return false;};
  const vecOf=a=>Array.isArray(a)?v(+a[0],+a[1],+a[2]):a&&typeof a==='object'?v(+a.x,+a.y,+a.z):null;
  const quatOf=a=>Array.isArray(a)?{x:+a[0],y:+a[1],z:+a[2],w:+a[3]}:a&&typeof a==='object'?{x:+a.x,y:+a.y,z:+a.z,w:+a.w}:null;
  function tryStick(ev) {
    if(!ev||!(ev.impulse>=STICK_MIN)||!ev.point||!ev.normal||!ev.relVelocity||!Array.isArray(ev.colliders)||ev.colliders.length!==2) return null;
    const bodies=ev.colliders.map(bodyOfHandle); if(!bodies[0]||!bodies[1]) return null;
    for(let i=0;i<2;i++) {
      const w=propOfBody(bodies[i]); if(!w||!w.e.edges.length||w.e.fixed||w.e.kinematic||sticks.has(w.id)) continue;
      const other=bodies[1-i]; if(isHandBody(other)) continue;
      const o=propOfBody(other); if(!o||holdMask(o.id)) continue; // never into something a hand is holding
      const material=contacts.materialOf(ev.colliders[1-i]),cap=STICKY[material]; if(!cap) continue;
      // relVelocity is the striker's (the faster collider's) velocity relative to the other; the normal points out of the
      // struck surface toward the striker. Seen from the weapon: its velocity relative to the other, and the way into it.
      const striker=Number.isInteger(ev.striker)?ev.striker:0;
      const vrel=striker===i?ev.relVelocity:scale(ev.relVelocity,-1);
      const into=striker===i?scale(ev.normal,-1):ev.normal;
      const speed=norm(vrel); if(speed<BITE_SPEED) continue;
      const bp=w.e.body.translation(),bq=w.e.body.rotation();
      for(const edge of w.e.edges) {
        if(norm(sub(ev.point,plus(bp,rotate(edge.p,bq))))>edge.r) continue;
        const dirW=rotate(edge.dir,bq),along=dot(vrel,dirW);
        if(along<BITE_SPEED||along<BITE_ALIGN*speed||dot(dirW,into)<.35) continue;
        const depth=Math.min(cap,Math.max(DEPTH_MIN,ev.impulse*DEPTH_PER_NS));
        return stick(w.id,o.id,{point:ev.point,dir:dirW,depth,material,impulse:ev.impulse,normal:into,time:ev.time,surface:contacts.surfaceOf(ev.colliders[1-i])??material});
      }
    }
    return null;
  }
  // Effects context on every contact, written onto the event before the effects see it (listeners run in registration
  // order; this one is registered first). ids: the prop id behind each collider ('hand' for a hand, null for unknown).
  // edge: when the striker's biting edge (js/physics/edges.js) lies within reach of the contact point, {id, dir (world unit),
  // along (cos of the edge against its motion)}, whether or not it stuck: a sword tip dragged across a wall cuts along its
  // edge. blunt: the striker is a held part with no edge (bat, staff, hammer: knocks, never cuts). Nothing here changes what
  // the solver, the stick rule or the haptics read. Step 6, Oct 26 2026.
  function annotate(ev) {
    if(!ev||!Array.isArray(ev.colliders)||ev.colliders.length!==2) return;
    const bodies=ev.colliders.map(bodyOfHandle);
    ev.ids=bodies.map(b=>b?(propOfBody(b)?.id??(isHandBody(b)?'hand':null)):null);
    ev.edge=null;ev.blunt=false;
    const striker=Number.isInteger(ev.striker)?ev.striker:0;
    const w=bodies[striker]?propOfBody(bodies[striker]):null;
    if(!w||w.e.fixed) return;
    if(!w.e.edges.length){ev.blunt=holdMask(w.id)!==0;return;}
    if(!ev.point) return;
    const bp=w.e.body.translation(),bq=w.e.body.rotation(),vrel=ev.relVelocity??null; // the striker's velocity relative to what it hit
    const speed=vrel?norm(vrel):0;
    for(const edge of w.e.edges) {
      if(norm(sub(ev.point,plus(bp,rotate(edge.p,bq))))>edge.r+.02) continue;
      const dirW=rotate(edge.dir,bq);
      ev.edge={id:w.id,dir:dirW,along:speed>1e-6?dot(vrel,dirW)/speed:0};
      return;
    }
  }
  const localPoint=(b,p)=>rotate(sub(p,b.translation()),inverse(b.rotation()));
  // Stick weapon `id` into `onId` at the world `point`, biting along the world `dir`, `depth` metres in.
  function stick(id,onId,{point,dir,depth,material='soft',impulse=0,normal=null,time=null,surface=null}={}) {
    const w=props.get(id),o=props.get(onId);
    if(!w||!o||id===onId||w.fixed||w.kinematic||sticks.has(id)||!point||!dir) return null;
    const d=Math.max(DEPTH_MIN,+depth||DEPTH_MIN),dirU=scale(dir,1/(norm(dir)||1));
    const saved={on:onId,a:localPoint(o.body,plus(point,scale(dirU,d))),b:localPoint(w.body,point),q:unit(mul(inverse(o.body.rotation()),w.body.rotation())),dir:rotate(dirU,inverse(o.body.rotation())),d,m:material};
    return stickAt(id,onId,saved,{impulse,normal,point,time,surface:surface??material,bite:true});
  }
  // Set (or re-set after a reload or a handover) a stick from its saved relation {on, a, b, q, dir, d, m}: a = anchor on
  // the struck body (local), b = anchor on the weapon (local), q = the weapon's rotation in the struck body's frame,
  // dir = the bite direction in the struck body's frame, d = depth, m = the struck material. Arrays or {x,y,z} alike.
  function stickAt(id,onId,saved,extra=null) {
    const w=props.get(id),o=props.get(onId);
    if(!w||!o||id===onId||w.fixed||w.kinematic||!saved) return null;
    const a=vecOf(saved.a),b=vecOf(saved.b),q=quatOf(saved.q),dir=vecOf(saved.dir);
    if(!a||!b||!q||!dir||![a.x,a.y,a.z,b.x,b.y,b.z,q.x,q.y,q.z,q.w,dir.x,dir.y,dir.z].every(Number.isFinite)||!(norm(dir)>1e-6)) return null;
    unstick(id);
    const joint=world.createImpulseJoint(R.JointData.fixed(a,unit(q),b,IDENTITY),o.body,w.body,true);
    joint.setContactsEnabled(false);
    const d=Math.max(DEPTH_MIN,+saved.d||DEPTH_MIN),material=typeof saved.m==='string'?saved.m:'soft';
    // A saved relation is already unit (stickState wrote it): keep it as is, so a reload's stickState equals the record and
    // nothing is written back; only a hand-made or drifted one is renormalized (the float drift surfaced in remaster step 11).
    const nq=Math.hypot(q.x,q.y,q.z,q.w),nd=norm(dir);
    const st={id,onId,joint,a,b,q:Math.abs(nq-1)<1e-9?q:unit(q),dir:Math.abs(nd-1)<1e-9?dir:scale(dir,1/nd),depth:d,material,hold:HOLD_BASE+HOLD_PER_M*d,tug:0,at:contacts.stats().time};
    sticks.set(id,st);w.body.wakeUp();o.body.wakeUp();
    const point=extra?.point??plus(o.body.translation(),rotate(a,o.body.rotation())),time=extra?.time??contacts.stats().time;
    bus.emit('stick',{id,onId,depth:d,hold:st.hold,material,impulse:extra?.impulse??0,point,normal:extra?.normal??null,hands:holders(id),time});
    // A fresh bite (not a reload or a handover re-set) is what the effects respond to: the gash and the chips or wisps at the
    // entry point, along the bite direction (LOOK-BIBLE.md section 7). The 'stick' event's keys stay as the checks pin them.
    if(extra?.bite) bus.emit('bite',{id,onId,point,normal:extra?.normal??null,dir:rotate(st.dir,o.body.rotation()),depth:d,impulse:extra?.impulse??0,material,surface:extra?.surface??material,time});
    return st;
  }
  // Drop the stick. `freed` (a tug, not a removal or a handover) is told to the bus.
  function unstick(id,freed=false,why='') {
    const st=sticks.get(id); if(!st) return false;
    if(st.joint){try{world.removeImpulseJoint(st.joint,true);}catch{}st.joint=null;}
    sticks.delete(id);
    const w=props.get(id); if(w)w.body.wakeUp();
    if(freed) bus.emit('unstick',{id,onId:st.onId,depth:st.depth,hold:st.hold,tug:st.tug,why,hands:holders(id),time:contacts.stats().time});
    return true;
  }
  function driveStick(st) {
    const w=props.get(st.id),o=props.get(st.onId);
    if(!w||!o){unstick(st.id);return;}
    const dirW=rotate(st.dir,o.body.rotation());
    let pull=0;
    for(const h of hands.values()) {
      if(!h.joint||h.id!==st.id||!h.target) continue;
      const off=sub(h.target.p,h.body.translation()),d=norm(off);
      if(d<=TUG_START) continue;
      const f=Math.min(1,(d-TUG_START)/(TUG_FULL-TUG_START));
      const along=-dot(scale(off,1/d),dirW); // 1 = straight back out along the blade, 0 = prying sideways, -1 = pushing it deeper
      pull+=FORCE*dt*f*Math.max(0,.3+.7*along);
    }
    st.tug=pull>0?st.tug+pull:Math.max(0,st.tug-TUG_DECAY*dt);
    if(st.tug>=st.hold) unstick(st.id,true,'tug');
  }
  const stuck=id=>{const st=sticks.get(id);return st?{onId:st.onId,depth:st.depth,hold:st.hold,tug:st.tug,material:st.material,at:st.at}:null;};
  // The saved relation of a stuck weapon, as plain arrays for a room record: {on, a, b, q, dir, d, m} (stickAt reads it back).
  const stickState=id=>{const st=sticks.get(id);return st?{on:st.onId,a:[st.a.x,st.a.y,st.a.z],b:[st.b.x,st.b.y,st.b.z],q:[st.q.x,st.q.y,st.q.z,st.q.w],dir:[st.dir.x,st.dir.y,st.dir.z],d:st.depth,m:st.material}:null;};
  const offAnnotate=bus.on('contact',annotate);
  const offStick=bus.on('contact',tryStick);
  function advance(frameDt) {
    if(!Number.isFinite(frameDt)||frameDt<0) return accumulator/dt;
    accumulator+=Math.min(frameDt,dt*4);
    let n=0;
    while(accumulator+1e-12>=dt&&n++<4) {
      for(const e of props.values()) e.previous={p:{...e.body.translation()},q:{...e.body.rotation()}};
      const driven=new Set(); // an object two hands hold is driven once, by the first hand that reaches it
      for(const [name,h] of hands){driveAlign(h);if(!(h.joint&&driven.has(h.id)))drive(h);if(h.joint)driven.add(h.id);drivePull(name,h);if(h.ghost>0&&(h.ghost-=dt)<=0)h.body.collider(0).setCollisionGroups(groupsOf(h.bit));}
      for(const mt of [...mounts.values()]) driveMount(mt);
      for(const st of [...sticks.values()]) driveStick(st);
      for(const e of props.values()) if(e.kinematic) driveFollow(e);
      contacts.step(dt);steps++;accumulator=Math.max(0,accumulator-dt);
    }
    return accumulator/dt;
  }
  // Signed distance from a world point to the nearest surface of body `id` (negative inside), over all its colliders:
  // what a finger closing on a held thing stops against. Infinity for an unknown body. clearanceProbe(id,center,radius)
  // returns the same query restricted to the colliders within `radius` of `center` (world), for many points near one spot.
  const colliderReach=c=>{const s=c.shape;if(!s)return Infinity;return s.radius??(s.halfExtents?Math.hypot(s.halfExtents.x,s.halfExtents.y,s.halfExtents.z):Infinity);};
  function clearanceProbe(id,center=null,radius=Infinity) {
    const e=props.get(id); if(!e)return ()=>Infinity;
    const list=[];
    for(let i=0;i<e.body.numColliders();i++) {
      const c=e.body.collider(i);
      if(center){const t=c.translation();if(Math.hypot(t.x-center.x,t.y-center.y,t.z-center.z)>radius+colliderReach(c))continue;}
      list.push(c);
    }
    return point=>{
      let best=Infinity;
      for(const c of list) {
        const pr=c.projectPoint(point,false); if(!pr)continue;
        const d=Math.hypot(pr.point.x-point.x,pr.point.y-point.y,pr.point.z-point.z);
        const s=pr.isInside?-d:d; if(s<best)best=s;
      }
      return best;
    };
  }
  const clearance=(id,point)=>clearanceProbe(id)(point);
  return {world,props,hands,mounts,sticks,contacts,dt,add,remove,targetHand,grab,pull,release,advance,clearance,clearanceProbe,
    mount,unmount,mounted:id=>mounts.has(id),lean:id=>mounts.get(id)?.lean??null,
    stick,stickAt,unstick:id=>unstick(id,true,'let go'),stuck,stickState,
    setKinematic,follow,kinematic:id=>!!props.get(id)?.kinematic,followVelocity:id=>props.get(id)?.follow?.vel??null,
    aligning:name=>!!hands.get(name)?.align,
    holders,
    stats:()=>({steps,bodies:props.size,kinematic:[...props.values()].filter(e=>e.kinematic).length,sticks:sticks.size,contacts:contacts.stats().emitted}),
    dispose(){offAnnotate();offStick();contacts.dispose();world.free();props.clear();hands.clear();mounts.clear();sticks.clear();}};
}
