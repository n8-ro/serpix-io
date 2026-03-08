const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ─── GAME CONSTANTS ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const TICK_RATE = 60;
const SEND_RATE = 20;
const WORLD_SIZE = 8000;
const FOOD_COUNT = 2000;
const BOT_COUNT = 50;
const INITIAL_SNAKE_LENGTH = 28;
const MAGNET_DISTANCE = 150;
const MAX_RADIUS = 50;
const MAX_SEGMENTS_SEND = 150;
const VIEWPORT_BUFFER = 2000;
const POWER_BOOST_INTERVAL = 120000;
const POWER_BOOST_DURATION = 5000;
const MAX_BOTS_AI_PER_FRAME = 25;

const COLORS = ['#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#ffffff'];
const SNAKE_PATTERNS = ['solid','striped','spotted','gradient'];
const BOT_NAMES = [
    "Shadow","Phoenix","Viper","Cobra","Mamba","Python","Anaconda","Venom",
    "Striker","Hunter","Reaper","Ghost","Phantom","Specter","Wraith","Banshee",
    "Dragon","Titan","Goliath","Behemoth","Leviathan","Kraken","Hydra","Cerberus",
    "Blaze","Inferno","Frost","Thunder","Lightning","Storm","Tempest","Hurricane",
    "Razor","Blade","Fang","Talon","Claw","Spike","Thorn","Barb",
    "Nova","Stellar","Cosmic","Nebula","Eclipse","Comet","Meteor","Asteroid",
    "Apex","Alpha","Omega","Prime","Elite","Supreme","Ultimate","Master",
    "Rogue","Outlaw","Rebel","Maverick","Vandal","Raider","Marauder","Bandit",
    "Vortex","Cyclone","Whirlwind","Tornado","Typhoon","Monsoon","Blizzard","Avalanche",
    "Sentinel","Guardian","Defender","Protector","Warden","Keeper","Custodian","Sentry"
];

// ─── FOOD CLASS ─────────────────────────────────────────────
let foodIdCounter = 0;
class Food {
    constructor(isPremium = false) {
        this.id = foodIdCounter++;
        this.isPremium = isPremium;
        this.reset();
    }
    reset() {
        this.x = Math.random() * WORLD_SIZE;
        this.y = Math.random() * WORLD_SIZE;
        this.radius = this.isPremium ? 8 : 3 + Math.random() * 4;
        this.colorIdx = Math.floor(Math.random() * COLORS.length);
        this.color = COLORS[this.colorIdx];
        this.value = this.isPremium ? 10 : 1;
        this.magnetizedTo = null;
    }
}

// ─── SNAKE CLASS ────────────────────────────────────────────
let snakeIdCounter = 0;
class Snake {
    constructor(name, color, isBot, pattern, game) {
        this.id = snakeIdCounter++;
        this.name = name || "Unnamed";
        this.color = color;
        this.pattern = pattern || 'solid';
        this.isBot = isBot;
        this.game = game;
        this.segments = [];
        this.angle = Math.random() * Math.PI * 2;
        this.targetAngle = this.angle;
        this.baseSpeed = 1.5;
        this.speed = 1.5;
        this.baseRadius = 14;
        this.radius = 14;
        this.score = 0;
        this.dead = false;
        this.isBoosting = false;
        this.invulnerable = 60;
        this.powerBoost = false;
        this.powerBoostEndTime = 0;
        this.boostFrameCounter = 0;
        this.isWrapping = false;
        this.wrapTarget = null;
        this.wrapComplete = false;
        this.wrapRadius = 0;
        this.wrapTightenCounter = 0;
        this.aiUpdateCounter = Math.floor(Math.random() * 3);
        this.ws = null; // WebSocket for player snakes

        const pos = this.findSafeSpawnPoint();
        for (let i = 0; i < INITIAL_SNAKE_LENGTH; i++) {
            this.segments.push({ x: pos.x, y: pos.y });
        }
    }

    findSafeSpawnPoint() {
        let bestX = Math.random() * (WORLD_SIZE - 600) + 300;
        let bestY = Math.random() * (WORLD_SIZE - 600) + 300;
        let maxMinDist = -1;
        for (let i = 0; i < 15; i++) {
            const tx = Math.random() * (WORLD_SIZE - 600) + 300;
            const ty = Math.random() * (WORLD_SIZE - 600) + 300;
            let minD = Infinity;
            for (const s of this.game.snakes) {
                if (s.dead || s.segments.length === 0) continue;
                const d = Math.hypot(s.segments[0].x - tx, s.segments[0].y - ty);
                if (d < minD) minD = d;
            }
            if (minD > maxMinDist) { maxMinDist = minD; bestX = tx; bestY = ty; }
        }
        return { x: bestX, y: bestY };
    }

    update(fullAI) {
        if (this.dead) return;
        if (this.invulnerable > 0) this.invulnerable--;

        if (this.powerBoost && Date.now() > this.powerBoostEndTime) {
            this.powerBoost = false;
        }

        if (this.powerBoost) {
            this.isBoosting = true;
        } else if (!this.isBot) {
            // Player: isBoosting set via input
        } else {
            const shouldBoostForWrap = this.isWrapping && this.score > 300 && this.wrapTarget && this.score > this.wrapTarget.score * 3;
            const shouldBoostRandom = Math.random() < 0.05 && this.score > 50;
            if (shouldBoostForWrap || shouldBoostRandom) this.isBoosting = true;
        }

        if (this.isBot && !fullAI) {
            this.angle += (Math.random() - 0.5) * 0.02;
            const buf = 300;
            const hx = this.segments[0].x, hy = this.segments[0].y;
            if (hx < buf) this.angle = Math.abs(this.angle) % (Math.PI * 2);
            if (hx > WORLD_SIZE - buf) this.angle = (Math.PI + Math.abs(this.angle)) % (Math.PI * 2);
            if (hy < buf) this.angle = (Math.PI / 2 + (this.angle % (Math.PI / 2)));
            if (hy > WORLD_SIZE - buf) this.angle = (-Math.PI / 2 + (this.angle % (Math.PI / 2)));
            this.performMovement();
            return;
        }

        if (this.isBoosting && this.score > 20) {
            this.speed = this.baseSpeed * 2;
            if (!this.powerBoost) {
                this.boostFrameCounter++;
                if (this.boostFrameCounter >= 15) { this.score -= 1; this.boostFrameCounter = 0; }
            }
        } else {
            this.speed = this.baseSpeed;
            this.boostFrameCounter = 0;
        }

        const snakes = this.game.snakes;

        if (this.isBot) {
            if (!this.powerBoost) this.isBoosting = false;
            let targetAngle = null;

            if (this.powerBoost) {
                let nearestSnake = null, minDist = Infinity;
                for (const s of snakes) {
                    if (s === this || s.dead) continue;
                    const d = Math.hypot(s.segments[0].x - this.segments[0].x, s.segments[0].y - this.segments[0].y);
                    if (d < minDist) { minDist = d; nearestSnake = s; }
                }
                if (nearestSnake) {
                    targetAngle = Math.atan2(nearestSnake.segments[0].y - this.segments[0].y, nearestSnake.segments[0].x - this.segments[0].x);
                    let diff = targetAngle - this.angle;
                    while (diff < -Math.PI) diff += Math.PI * 2;
                    while (diff > Math.PI) diff -= Math.PI * 2;
                    this.angle += diff * 0.08;
                }
            } else {
                // Threat detection
                let immediateThreat = null, threatDistance = Infinity;
                const myX = this.segments[0].x, myY = this.segments[0].y;
                const myAngle = this.angle;
                const lookAheadDist = 200 + (this.speed * 30);

                for (const s of snakes) {
                    if (s === this || s.dead) continue;
                    const oh = s.segments[0];
                    const dist = Math.hypot(oh.x - myX, oh.y - myY);
                    const aTo = Math.atan2(oh.y - myY, oh.x - myX);
                    let ad = Math.abs(aTo - myAngle);
                    while (ad > Math.PI) ad = Math.PI * 2 - ad;
                    if (ad < Math.PI / 3 && dist < lookAheadDist) {
                        const tl = (s.score > this.score ? 2 : 1) * (1 / Math.max(dist, 1));
                        const ctl = immediateThreat ? (1 / Math.max(threatDistance, 1)) : 0;
                        if (tl > ctl) { immediateThreat = s; threatDistance = dist; }
                    }
                }

                if (immediateThreat && threatDistance < 150) {
                    const tx = immediateThreat.segments[0].x, ty = immediateThreat.segments[0].y;
                    const aToT = Math.atan2(ty - myY, tx - myX);
                    const evade = aToT + (Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
                    let diff = evade - this.angle;
                    while (diff < -Math.PI) diff += Math.PI * 2;
                    while (diff > Math.PI) diff -= Math.PI * 2;
                    this.angle += diff * 0.15;
                    if (threatDistance < 100 && this.score > 50) this.isBoosting = true;
                }

                // Wrap detection
                let beingWrapped = false, wrapperSnake = null;
                for (const s of snakes) {
                    if (s === this || s.dead) continue;
                    if (s.score <= this.score * 0.8) continue;
                    let nearby = 0;
                    for (const seg of s.segments) {
                        if (Math.hypot(seg.x - myX, seg.y - myY) < 180) nearby++;
                    }
                    if (nearby > 6) { beingWrapped = true; wrapperSnake = s; break; }
                }

                if (beingWrapped && wrapperSnake) {
                    let nearSeg = null, nearD = Infinity;
                    for (const seg of wrapperSnake.segments) {
                        const d = Math.hypot(seg.x - myX, seg.y - myY);
                        if (d < nearD) { nearD = d; nearSeg = seg; }
                    }
                    let largestGap = null, largestGapSize = 0;
                    for (let i = 0; i < 16; i++) {
                        const a = (i / 16) * Math.PI * 2;
                        const tx = myX + Math.cos(a) * 100, ty = myY + Math.sin(a) * 100;
                        let minD2 = Infinity;
                        for (const seg of wrapperSnake.segments) {
                            const d = Math.hypot(seg.x - tx, seg.y - ty);
                            if (d < minD2) minD2 = d;
                        }
                        if (minD2 > largestGapSize) { largestGapSize = minD2; largestGap = a; }
                    }
                    if (largestGapSize > wrapperSnake.radius * 2.5 + 50) {
                        let diff = largestGap - this.angle;
                        while (diff < -Math.PI) diff += Math.PI * 2;
                        while (diff > Math.PI) diff -= Math.PI * 2;
                        this.angle += diff * 0.12;
                        if (this.score > 30) this.isBoosting = true;
                    } else if (nearSeg) {
                        const aToN = Math.atan2(nearSeg.y - myY, nearSeg.x - myX);
                        if (nearD < wrapperSnake.radius + this.radius + 40) {
                            const away = aToN + Math.PI;
                            let diff = away - this.angle;
                            while (diff < -Math.PI) diff += Math.PI * 2;
                            while (diff > Math.PI) diff -= Math.PI * 2;
                            this.angle += diff * 0.06;
                        } else {
                            const tangent = aToN + Math.PI / 2;
                            let diff = tangent - this.angle;
                            while (diff < -Math.PI) diff += Math.PI * 2;
                            while (diff > Math.PI) diff -= Math.PI * 2;
                            this.angle += diff * 0.05;
                        }
                    }
                } else {
                    // Wall avoidance
                    const wallBuf = 200;
                    const lookDist = 100 + this.radius * 3;
                    const checkX = myX + Math.cos(this.angle) * lookDist;
                    const checkY = myY + Math.sin(this.angle) * lookDist;
                    let wallDanger = false;
                    if (checkX < wallBuf || checkX > WORLD_SIZE - wallBuf || checkY < wallBuf || checkY > WORLD_SIZE - wallBuf ||
                        myX < wallBuf * 1.5 || myX > WORLD_SIZE - wallBuf * 1.5 || myY < wallBuf * 1.5 || myY > WORLD_SIZE - wallBuf * 1.5) {
                        wallDanger = true;
                        const cX = WORLD_SIZE / 2, cY = WORLD_SIZE / 2;
                        const aToC = Math.atan2(cY - myY, cX - myX);
                        let diff = aToC - this.angle;
                        while (diff < -Math.PI) diff += Math.PI * 2;
                        while (diff > Math.PI) diff -= Math.PI * 2;
                        this.angle += diff * 0.06;
                    }

                    if (!wallDanger) {
                        let dangerAhead = false, dangerSnake = null, canAttackSnake = null;

                        for (const s of snakes) {
                            if (s === this || s.dead) continue;
                            const sizeReq = this.score < 300 ? 2.0 : 1.5;
                            if (this.score > 200 && this.score > s.score * sizeReq) {
                                const th = s.segments[0];
                                const pT = 20;
                                const pX = th.x + Math.cos(s.angle) * s.speed * pT;
                                const pY = th.y + Math.sin(s.angle) * s.speed * pT;
                                const dP = Math.hypot(pX - myX, pY - myY);
                                const dC = Math.hypot(th.x - myX, th.y - myY);
                                const atk = this.score > 500 ? 0.15 : 0.1;
                                if (dP < 200 && dC > 100 && dC < 600 && Math.random() < atk) {
                                    canAttackSnake = { x: pX, y: pY, target: s };
                                }
                            }
                            const limit = Math.min(s.segments.length, 50);
                            for (let i = 0; i < limit; i++) {
                                const seg = s.segments[i];
                                const d = Math.hypot(checkX - seg.x, checkY - seg.y);
                                const margin = s.score > this.score ? 60 : 40;
                                if (d < this.radius + s.radius + margin) {
                                    dangerAhead = true; dangerSnake = s; break;
                                }
                            }
                        }

                        const isSafe = !dangerAhead && !beingWrapped && !immediateThreat;

                        if (canAttackSnake && isSafe) {
                            targetAngle = Math.atan2(canAttackSnake.y - myY, canAttackSnake.x - myX);
                            let diff = targetAngle - this.angle;
                            while (diff < -Math.PI) diff += Math.PI * 2;
                            while (diff > Math.PI) diff -= Math.PI * 2;
                            this.angle += diff * 0.08;
                        } else if (dangerAhead && dangerSnake) {
                            let avgX = 0, avgY = 0, cnt = 0;
                            for (const seg of dangerSnake.segments) {
                                if (Math.hypot(seg.x - myX, seg.y - myY) < 300) { avgX += seg.x; avgY += seg.y; cnt++; }
                            }
                            if (cnt > 0) {
                                avgX /= cnt; avgY /= cnt;
                                const aToS = Math.atan2(avgY - myY, avgX - myX);
                                let bestA = this.angle, bestC = -1;
                                for (let off = -Math.PI; off < Math.PI; off += Math.PI / 4) {
                                    const tA = aToS + Math.PI + off;
                                    const tX = myX + Math.cos(tA) * 150, tY = myY + Math.sin(tA) * 150;
                                    let minC = Infinity;
                                    for (const seg of dangerSnake.segments) { const d = Math.hypot(tX - seg.x, tY - seg.y); if (d < minC) minC = d; }
                                    for (const s of snakes) { if (s === this || s === dangerSnake || s.dead) continue; for (const seg of s.segments) { const d = Math.hypot(tX - seg.x, tY - seg.y); if (d < minC) minC = d; } }
                                    let ad = tA - this.angle; while (ad < -Math.PI) ad += Math.PI * 2; while (ad > Math.PI) ad -= Math.PI * 2;
                                    const sc = minC * 0.7 + (1 - Math.abs(ad) / Math.PI) * 100;
                                    if (sc > bestC) { bestC = sc; bestA = tA; }
                                }
                                let diff = bestA - this.angle;
                                while (diff < -Math.PI) diff += Math.PI * 2;
                                while (diff > Math.PI) diff -= Math.PI * 2;
                                this.angle += diff * 0.15;
                                if (dangerSnake.score > this.score && this.score > 40) this.isBoosting = true;
                            }
                        } else {
                            // Wrap attack behavior
                            this.aiUpdateCounter++;
                            const isInDanger = beingWrapped || immediateThreat || dangerAhead;

                            if (this.score > 300 && !isInDanger) {
                                let bestTarget = null, bestScore = -1, minDist = 1500;
                                for (const s of snakes) {
                                    if (s === this || s.dead) continue;
                                    if (s.score * 3 > this.score) continue;
                                    const d = Math.hypot(s.segments[0].x - myX, s.segments[0].y - myY);
                                    const ratio = this.score / s.score;
                                    const dF = Math.max(0, 1500 - d) / 1500;
                                    const sF = Math.min(s.score / 500, 1);
                                    const ws = ratio * 0.4 + dF * 0.4 + sF * 0.2;
                                    if (d < minDist && ws > bestScore) { bestScore = ws; bestTarget = s; minDist = d; }
                                }

                                if (bestTarget && minDist < 1500) {
                                    const shouldSwitch = !this.isWrapping || (this.wrapTarget && this.wrapTarget.dead) || (this.wrapTarget && bestTarget.score > this.wrapTarget.score * 1.5);
                                    if (shouldSwitch) {
                                        this.isWrapping = true; this.wrapTarget = bestTarget; this.wrapComplete = false; this.wrapRadius = 0; this.wrapTightenCounter = 0;
                                    }
                                }

                                const tgt = this.isWrapping && this.wrapTarget && !this.wrapTarget.dead ? this.wrapTarget : null;
                                if (tgt) {
                                    const tX = tgt.segments[0].x, tY = tgt.segments[0].y;
                                    const dToT = Math.hypot(myX - tX, myY - tY);
                                    const edgeBuf = 400;
                                    const nearEdge = tX < edgeBuf || tX > WORLD_SIZE - edgeBuf || tY < edgeBuf || tY > WORLD_SIZE - edgeBuf;
                                    const tooFar = dToT > 2000;
                                    const tooLarge = tgt.score * 3 > this.score;
                                    if (tooFar || nearEdge || tooLarge || isInDanger) {
                                        this.isWrapping = false; this.wrapTarget = null; this.wrapComplete = false;
                                    } else {
                                        const wrapDist = tgt.radius * 3 + this.radius * 2 + 80;
                                        let coverageMap = new Array(24).fill(false);
                                        for (const seg of this.segments) {
                                            const dx = seg.x - tX, dy = seg.y - tY, dist = Math.hypot(dx, dy);
                                            if (dist > wrapDist - 60 && dist < wrapDist + 60) {
                                                const a = Math.atan2(dy, dx);
                                                coverageMap[Math.floor(((a + Math.PI) / (Math.PI * 2)) * 24) % 24] = true;
                                            }
                                        }
                                        const cov = coverageMap.filter(x => x).length / 24;
                                        const curA = Math.atan2(myY - tY, myX - tX);

                                        if (cov < 0.25) {
                                            let goalX, goalY;
                                            if (dToT < wrapDist - 60) {
                                                const ca = curA + Math.PI / 3;
                                                goalX = tX + Math.cos(ca) * wrapDist; goalY = tY + Math.sin(ca) * wrapDist;
                                            } else if (dToT > wrapDist + 120) {
                                                const ta = Math.atan2(tY - myY, tX - myX) + Math.PI / 3;
                                                goalX = tX + Math.cos(ta) * wrapDist; goalY = tY + Math.sin(ta) * wrapDist;
                                            } else {
                                                const na = curA + Math.PI / 6;
                                                goalX = tX + Math.cos(na) * wrapDist; goalY = tY + Math.sin(na) * wrapDist;
                                            }
                                            targetAngle = Math.atan2(goalY - myY, goalX - myX);
                                        } else if (cov < 0.7) {
                                            let gStart = -1, gSize = 0, bStart = -1, bSize = 0;
                                            for (let i = 0; i < 48; i++) {
                                                if (!coverageMap[i % 24]) {
                                                    if (gStart === -1) gStart = i % 24;
                                                    gSize++;
                                                } else {
                                                    if (gSize > bSize) { bSize = gSize; bStart = gStart; }
                                                    gStart = -1; gSize = 0;
                                                }
                                            }
                                            if (gSize > bSize) { bSize = gSize; bStart = gStart; }
                                            if (bStart !== -1 && bSize > 2) {
                                                const mid = (bStart + bSize / 2) % 24;
                                                const ga = (mid / 24) * Math.PI * 2 - Math.PI;
                                                const gx = tX + Math.cos(ga) * wrapDist, gy = tY + Math.sin(ga) * wrapDist;
                                                targetAngle = Math.atan2(gy - myY, gx - myX);
                                            } else {
                                                const na = curA + Math.PI / 8;
                                                const gx = tX + Math.cos(na) * wrapDist, gy = tY + Math.sin(na) * wrapDist;
                                                targetAngle = Math.atan2(gy - myY, gx - myX);
                                            }
                                        } else {
                                            if (!this.wrapComplete) {
                                                let hasGap = coverageMap.some(c => !c);
                                                if (hasGap) {
                                                    const tr = wrapDist * 0.75;
                                                    let gStart = -1, gSize = 0, bStart = -1, bSize = 0;
                                                    for (let i = 0; i < 48; i++) {
                                                        if (!coverageMap[i % 24]) {
                                                            if (gStart === -1) gStart = i % 24; gSize++;
                                                        } else {
                                                            if (gSize > bSize) { bSize = gSize; bStart = gStart; }
                                                            gStart = -1; gSize = 0;
                                                        }
                                                    }
                                                    if (gSize > bSize) { bSize = gSize; bStart = gStart; }
                                                    if (bStart !== -1) {
                                                        const mid = (bStart + bSize / 2) % 24;
                                                        const ga = (mid / 24) * Math.PI * 2 - Math.PI;
                                                        targetAngle = Math.atan2(tY + Math.sin(ga) * tr - myY, tX + Math.cos(ga) * tr - myX);
                                                    }
                                                } else {
                                                    this.wrapComplete = true; this.wrapRadius = wrapDist * 0.75; this.wrapTightenCounter = 0;
                                                }
                                            }
                                            if (this.wrapComplete) {
                                                this.wrapTightenCounter++;
                                                if (this.wrapTightenCounter >= 30) {
                                                    const minR = tgt.radius * 2.5 + this.radius * 1.5;
                                                    if (this.wrapRadius > minR) this.wrapRadius -= 2;
                                                    this.wrapTightenCounter = 0;
                                                }
                                                const na = curA + Math.PI / 6;
                                                const gx = tX + Math.cos(na) * this.wrapRadius, gy = tY + Math.sin(na) * this.wrapRadius;
                                                targetAngle = Math.atan2(gy - myY, gx - myX);
                                            }
                                        }
                                    }
                                } else {
                                    this.isWrapping = false; this.wrapTarget = null; this.wrapComplete = false;
                                }
                            } else {
                                this.isWrapping = false; this.wrapTarget = null; this.wrapComplete = false;
                            }

                            // Food seeking
                            if (targetAngle === null) {
                                this.isWrapping = false; this.wrapTarget = null; this.wrapComplete = false;
                                let nearDeath = null, deathD = 1200;
                                for (const dl of this.game.deathLocations) {
                                    const d = Math.hypot(dl.x - myX, dl.y - myY);
                                    if (d < deathD) { deathD = d; nearDeath = dl; }
                                }
                                if (nearDeath) {
                                    targetAngle = Math.atan2(nearDeath.y - myY, nearDeath.x - myX);
                                } else {
                                    let nearFood = null, fDist = 400;
                                    for (const f of this.game.foods) {
                                        const d = Math.hypot(f.x - myX, f.y - myY);
                                        if (d < fDist) { fDist = d; nearFood = f; }
                                    }
                                    if (nearFood) targetAngle = Math.atan2(nearFood.y - myY, nearFood.x - myX);
                                }
                            }

                            if (targetAngle !== null) {
                                let diff = targetAngle - this.angle;
                                while (diff < -Math.PI) diff += Math.PI * 2;
                                while (diff > Math.PI) diff -= Math.PI * 2;
                                this.angle += diff * 0.05;
                            } else {
                                this.angle += (Math.random() - 0.5) * 0.03;
                            }
                        }
                    }
                }
            }
        } else {
            // Player input: smooth turning toward target angle
            let diff = this.targetAngle - this.angle;
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            this.angle += diff * 0.06;
        }

        this.performMovement();
    }

    performMovement() {
        const head = this.segments[0];
        const nextX = head.x + Math.cos(this.angle) * this.speed;
        const nextY = head.y + Math.sin(this.angle) * this.speed;

        if (nextX < 0 || nextX > WORLD_SIZE || nextY < 0 || nextY > WORLD_SIZE) {
            this.die(); return;
        }

        if (this.invulnerable <= 0) {
            for (const other of this.game.snakes) {
                if (other.dead || other === this) continue;
                const headDist = Math.hypot(nextX - other.segments[0].x, nextY - other.segments[0].y);
                const maxDist = this.radius + other.radius + other.segments.length * 0.5;
                if (headDist > maxDist) continue;

                const colR = this.radius + other.radius + 50;
                for (let i = 0; i < other.segments.length; i++) {
                    const seg = other.segments[i];
                    const dist = Math.hypot(nextX - seg.x, nextY - seg.y);
                    if (dist > colR) continue;
                    if (dist < this.radius + other.radius * 0.7) {
                        if (this.powerBoost) {
                            const pts = Math.ceil(other.score * 0.1);
                            this.score += pts;
                            this.radius = Math.min(MAX_RADIUS, this.baseRadius + this.score * 0.005);
                            this.game.addKillNotification(this.segments[0].x, this.segments[0].y, pts);
                            other.die(); return;
                        } else {
                            const pts = Math.ceil(this.score * 0.1);
                            other.score += pts;
                            other.radius = Math.min(MAX_RADIUS, other.baseRadius + other.score * 0.005);
                            this.game.addKillNotification(other.segments[0].x, other.segments[0].y, pts);
                            this.die(); return;
                        }
                    }
                }
            }
        }

        this.segments.unshift({ x: nextX, y: nextY });
        if (this.isBoosting && this.segments.length > 1) {
            const prev = this.segments[1];
            this.segments.splice(1, 0, { x: (nextX + prev.x) / 2, y: (nextY + prev.y) / 2 });
        }

        const targetLen = INITIAL_SNAKE_LENGTH + this.score / 2;
        while (this.segments.length > targetLen) this.segments.pop();

        // Food collection
        const foodCheckR = MAGNET_DISTANCE + this.radius + 100;
        const toRemove = [];
        for (const f of this.game.foods) {
            const dist = Math.hypot(nextX - f.x, nextY - f.y);
            if (dist > foodCheckR) continue;
            if (dist < MAGNET_DISTANCE + this.radius * 2) f.magnetizedTo = this;
            if (f.magnetizedTo === this) {
                const pa = Math.atan2(nextY - f.y, nextX - f.x);
                f.x += Math.cos(pa) * (this.speed + 5);
                f.y += Math.sin(pa) * (this.speed + 5);
            }
            if (dist < this.radius + f.radius) {
                this.score += f.value;
                this.radius = Math.min(MAX_RADIUS, this.baseRadius + this.score * 0.005);
                if (f.isPremium) { toRemove.push(f); } else { f.reset(); f.magnetizedTo = null; }
            }
        }
        for (const f of toRemove) {
            const idx = this.game.foods.indexOf(f);
            if (idx > -1) this.game.foods.splice(idx, 1);
        }
    }

    die() {
        if (this.dead) return;
        this.dead = true;

        this.game.deathLocations.push({ x: this.segments[0].x, y: this.segments[0].y, createdAt: Date.now(), duration: 8000 });

        for (let i = 0; i < this.segments.length; i += 4) {
            const f = new Food(true);
            f.x = this.segments[i].x;
            f.y = this.segments[i].y;
            f.color = this.color;
            f.colorIdx = COLORS.indexOf(this.color);
            if (f.colorIdx === -1) f.colorIdx = 0;
            this.game.foods.push(f);
        }

        if (this.ws) {
            // Notify player they died
            this.game.sendToPlayer(this.ws, { t: 'dead', sc: Math.floor(this.score) });
        } else {
            // Bot died - respawn after delay
            setTimeout(() => {
                this.game.respawnBot(this);
            }, 2000);
        }
    }
}

// ─── GAME CLASS ─────────────────────────────────────────────
class Game {
    constructor() {
        this.snakes = [];
        this.foods = [];
        this.players = new Map(); // ws -> { snake, viewW, viewH }
        this.tickCount = 0;
        this.lastPowerBoostTime = Date.now();
        this.killNotifications = [];
        this.deathLocations = [];
        this.usedBotNames = new Set();
        this.powerBoostSnakeName = null;

        for (let i = 0; i < FOOD_COUNT; i++) this.foods.push(new Food());

        const startScores = [1000, 750, 500, 250, 125, 100, 25, 25, 25];
        for (let i = 0; i < BOT_COUNT; i++) {
            const name = this.getUniqueBotName();
            const color = COLORS[Math.floor(Math.random() * COLORS.length)];
            const pattern = SNAKE_PATTERNS[Math.floor(Math.random() * SNAKE_PATTERNS.length)];
            const bot = new Snake(name, color, true, pattern, this);
            bot.score = i < startScores.length ? startScores[i] : 1;
            bot.radius = Math.min(MAX_RADIUS, bot.baseRadius + bot.score * 0.005);
            const tLen = INITIAL_SNAKE_LENGTH + bot.score / 2;
            while (bot.segments.length < tLen) bot.segments.push({ x: bot.segments[0].x, y: bot.segments[0].y });
            this.snakes.push(bot);
        }
    }

    getUniqueBotName() {
        let name, attempts = 0;
        do {
            name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
            attempts++;
            if (attempts > 50) { name += Math.floor(Math.random() * 100); break; }
        } while (this.usedBotNames.has(name));
        this.usedBotNames.add(name);
        return name;
    }

    addKillNotification(x, y, pts) {
        this.killNotifications.push({ x, y, pts, createdAt: Date.now(), duration: 2000 });
    }

    respawnBot(oldBot) {
        const idx = this.snakes.indexOf(oldBot);
        if (idx > -1) { this.usedBotNames.delete(oldBot.name); this.snakes.splice(idx, 1); }
        const name = this.getUniqueBotName();
        const color = COLORS[Math.floor(Math.random() * COLORS.length)];
        const pattern = SNAKE_PATTERNS[Math.floor(Math.random() * SNAKE_PATTERNS.length)];
        const bot = new Snake(name, color, true, pattern, this);
        bot.score = 1;
        bot.radius = Math.min(MAX_RADIUS, bot.baseRadius + bot.score * 0.005);
        this.snakes.push(bot);
    }

    addPlayer(ws, name, color, pattern, bonus) {
        const snake = new Snake(name, color, false, pattern, this);
        snake.ws = ws;
        if (bonus > 0) {
            snake.score = bonus;
            snake.radius = Math.min(MAX_RADIUS, snake.baseRadius + snake.score * 0.005);
            const tLen = INITIAL_SNAKE_LENGTH + snake.score / 2;
            while (snake.segments.length < tLen) snake.segments.push({ x: snake.segments[0].x, y: snake.segments[0].y });
        }
        this.snakes.push(snake);
        this.players.set(ws, { snake, viewW: 1920, viewH: 1080 });
        return snake;
    }

    removePlayer(ws) {
        const pData = this.players.get(ws);
        if (pData && pData.snake) {
            if (!pData.snake.dead) pData.snake.die();
            const idx = this.snakes.indexOf(pData.snake);
            if (idx > -1) this.snakes.splice(idx, 1);
        }
        this.players.delete(ws);
    }

    sendToPlayer(ws, data) {
        if (ws.readyState === 1) {
            try { ws.send(JSON.stringify(data)); } catch (e) {}
        }
    }

    tick() {
        this.tickCount++;
        const now = Date.now();

        // Clean expired
        this.killNotifications = this.killNotifications.filter(k => now - k.createdAt < k.duration);
        this.deathLocations = this.deathLocations.filter(d => now - d.createdAt < d.duration);

        // Power boost
        if (now - this.lastPowerBoostTime > POWER_BOOST_INTERVAL) {
            const alive = this.snakes.filter(s => !s.dead);
            if (alive.length > 0) {
                // 30% chance a player gets it
                const playerSnakes = alive.filter(s => !s.isBot);
                let lucky;
                if (playerSnakes.length > 0 && Math.random() < 0.3) {
                    lucky = playerSnakes[Math.floor(Math.random() * playerSnakes.length)];
                } else {
                    lucky = alive[Math.floor(Math.random() * alive.length)];
                }
                lucky.powerBoost = true;
                lucky.powerBoostEndTime = now + POWER_BOOST_DURATION;
                this.lastPowerBoostTime = now;
                this.powerBoostSnakeName = lucky.name;
                // Broadcast boost notification
                for (const [ws] of this.players) {
                    this.sendToPlayer(ws, { t: 'boost', n: lucky.name });
                }
            }
        }

        // Update snakes with staggered AI
        let botsFullAI = 0;
        const botOff = this.tickCount % 3;
        // Get all player positions for proximity checks
        const playerPositions = [];
        for (const [, pData] of this.players) {
            if (pData.snake && !pData.snake.dead) {
                playerPositions.push(pData.snake.segments[0]);
            }
        }

        for (let i = 0; i < this.snakes.length; i++) {
            const s = this.snakes[i];
            if (s.dead) continue;
            if (!s.isBot) {
                s.update(true);
            } else {
                let nearPlayer = false;
                for (const pos of playerPositions) {
                    if (Math.hypot(s.segments[0].x - pos.x, s.segments[0].y - pos.y) < 2000) {
                        nearPlayer = true; break;
                    }
                }
                const fullAI = nearPlayer || ((i + botOff) % 3 === 0 && botsFullAI < MAX_BOTS_AI_PER_FRAME);
                if (fullAI) botsFullAI++;
                s.update(fullAI);
            }
        }

        // Broadcast state
        if (this.tickCount % Math.max(1, Math.round(TICK_RATE / SEND_RATE)) === 0) {
            this.broadcastState();
        }
    }

    broadcastState() {
        const now = Date.now();
        const sorted = this.snakes.filter(s => !s.dead).sort((a, b) => b.score - a.score);
        const lb = sorted.slice(0, 10).map(s => [s.name, Math.floor(s.score)]);
        const kingId = sorted.length > 0 ? sorted[0].id : -1;
        const totalCount = sorted.length;
        const timeToBoost = Math.max(0, Math.ceil((POWER_BOOST_INTERVAL - (now - this.lastPowerBoostTime)) / 1000));

        for (const [ws, pData] of this.players) {
            const snake = pData.snake;
            if (!snake || snake.dead) continue;

            const cx = snake.segments[0].x;
            const cy = snake.segments[0].y;
            const vw = pData.viewW || 1920;
            const vh = pData.viewH || 1080;
            const halfW = vw / 2 + VIEWPORT_BUFFER;
            const halfH = vh / 2 + VIEWPORT_BUFFER;

            // Nearby snakes
            const sn = [];
            for (const s of this.snakes) {
                if (s.dead) continue;
                const hx = s.segments[0].x, hy = s.segments[0].y;
                // Include if any part might be visible
                const dist = Math.hypot(hx - cx, hy - cy);
                if (dist > halfW + halfH + s.segments.length * 2) continue;

                const segs = [];
                const maxSeg = Math.min(s.segments.length, MAX_SEGMENTS_SEND);
                for (let i = 0; i < maxSeg; i++) {
                    segs.push(Math.round(s.segments[i].x));
                    segs.push(Math.round(s.segments[i].y));
                }

                sn.push({
                    id: s.id,
                    n: s.name,
                    c: s.color,
                    pt: s.pattern,
                    sg: segs,
                    a: Math.round(s.angle * 1000) / 1000,
                    r: Math.round(s.radius * 10) / 10,
                    sc: Math.floor(s.score),
                    bo: s.isBoosting,
                    pb: s.powerBoost,
                    iv: s.invulnerable > 0 ? 1 : 0,
                    me: s === snake ? 1 : 0,
                    k: s.id === kingId ? 1 : 0
                });
            }

            // Nearby food
            const fd = [];
            for (const f of this.foods) {
                if (Math.abs(f.x - cx) > halfW || Math.abs(f.y - cy) > halfH) continue;
                fd.push([Math.round(f.x), Math.round(f.y), Math.round(f.radius * 10) / 10, f.colorIdx, f.isPremium ? 1 : 0]);
            }

            // Kill notifications near player
            const kn = [];
            for (const k of this.killNotifications) {
                if (Math.abs(k.x - cx) < halfW && Math.abs(k.y - cy) < halfH) {
                    kn.push([Math.round(k.x), Math.round(k.y), k.pts, k.createdAt]);
                }
            }

            // Player rank
            const rank = sorted.findIndex(s => s === snake) + 1;

            // All snakes for minimap (just head positions and basic info)
            const mm = [];
            for (const s of this.snakes) {
                if (s.dead || s.segments.length === 0) continue;
                // Send head + a few body points for minimap
                const pts = [Math.round(s.segments[0].x), Math.round(s.segments[0].y)];
                const step = Math.max(1, Math.floor(s.segments.length / 10));
                for (let i = step; i < s.segments.length; i += step) {
                    pts.push(Math.round(s.segments[i].x));
                    pts.push(Math.round(s.segments[i].y));
                }
                mm.push({
                    id: s.id,
                    p: pts,
                    c: s === snake ? 1 : s.id === kingId ? 2 : s.powerBoost ? 3 : 0,
                    r: Math.round(s.radius * 10) / 10
                });
            }

            // Death locations for minimap
            const dl = this.deathLocations.map(d => [Math.round(d.x), Math.round(d.y), d.createdAt, d.duration]);

            this.sendToPlayer(ws, {
                t: 's',
                sn, fd, lb, kn, mm, dl,
                rk: rank,
                tc: totalCount,
                tb: timeToBoost
            });
        }
    }
}

// ─── HTTP SERVER ────────────────────────────────────────────
const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ico': 'image/x-icon'
};

const httpServer = http.createServer((req, res) => {
    let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : decodeURIComponent(req.url));
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Handle range requests for video
    if (ext === '.mp4' || ext === '.webm') {
        fs.stat(filePath, (err, stat) => {
            if (err) { res.writeHead(404); res.end('Not found'); return; }
            const range = req.headers.range;
            if (range) {
                const parts = range.replace(/bytes=/, '').split('-');
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
                const chunkSize = end - start + 1;
                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunkSize,
                    'Content-Type': contentType,
                });
                fs.createReadStream(filePath, { start, end }).pipe(res);
            } else {
                res.writeHead(200, {
                    'Content-Length': stat.size,
                    'Content-Type': contentType,
                });
                fs.createReadStream(filePath).pipe(res);
            }
        });
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

// ─── WEBSOCKET SERVER ───────────────────────────────────────
const game = new Game();

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
    let joined = false;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.t === 'join') {
            if (joined) return;
            joined = true;
            const name = (msg.n || 'Player').substring(0, 12);
            const color = msg.c || '#10b981';
            const pattern = msg.pt || 'solid';
            const bonus = msg.b || 0;
            const snake = game.addPlayer(ws, name, color, pattern, bonus);
            game.sendToPlayer(ws, { t: 'welcome', id: snake.id });
        } else if (msg.t === 'input') {
            const pData = game.players.get(ws);
            if (pData && pData.snake && !pData.snake.dead) {
                if (typeof msg.a === 'number' && isFinite(msg.a)) pData.snake.targetAngle = msg.a;
                pData.snake.isBoosting = !!msg.b;
            }
        } else if (msg.t === 'viewport') {
            const pData = game.players.get(ws);
            if (pData) {
                pData.viewW = Math.min(msg.w || 1920, 3840);
                pData.viewH = Math.min(msg.h || 1080, 2160);
            }
        } else if (msg.t === 'respawn') {
            const pData = game.players.get(ws);
            if (pData && pData.snake && pData.snake.dead) {
                // Remove old snake
                const idx = game.snakes.indexOf(pData.snake);
                if (idx > -1) game.snakes.splice(idx, 1);
                // Create new one
                const name = (msg.n || 'Player').substring(0, 12);
                const color = msg.c || '#10b981';
                const pattern = msg.pt || 'solid';
                const bonus = msg.b || 0;
                const snake = game.addPlayer(ws, name, color, pattern, bonus);
                // Update players map to point to new snake
                // (addPlayer already does this)
                game.sendToPlayer(ws, { t: 'welcome', id: snake.id });
            }
        }
    });

    ws.on('close', () => {
        game.removePlayer(ws);
    });

    ws.on('error', () => {
        game.removePlayer(ws);
    });
});

// ─── GAME LOOP ──────────────────────────────────────────────
const tickMs = 1000 / TICK_RATE;
let lastTick = Date.now();

function gameTick() {
    const now = Date.now();
    const delta = now - lastTick;

    // Run ticks to catch up (but cap to prevent spiral)
    const ticksToRun = Math.min(Math.floor(delta / tickMs), 3);
    for (let i = 0; i < ticksToRun; i++) {
        game.tick();
    }
    lastTick = now;
}

setInterval(gameTick, tickMs);

// ─── START ──────────────────────────────────────────────────
httpServer.listen(PORT, () => {
    console.log(`🐍 Serpix.io server running on http://localhost:${PORT}`);
    console.log(`   WebSocket ready for connections`);
    console.log(`   ${BOT_COUNT} bots initialized`);
});
