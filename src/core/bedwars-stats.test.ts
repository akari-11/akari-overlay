import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBedwarsStats, rankOf, ratio, starFromExperience, threatLevel } from './bedwars-stats';

test('starFromExperience follows the Hypixel prestige curve', () => {
  assert.equal(starFromExperience(0), 0);
  assert.equal(starFromExperience(499), 0);
  assert.equal(starFromExperience(500), 1);
  assert.equal(starFromExperience(1500), 2);
  assert.equal(starFromExperience(3500), 3);
  assert.equal(starFromExperience(7000), 4);
  assert.equal(starFromExperience(12000), 5);
  assert.equal(starFromExperience(487_000), 100);
  assert.equal(starFromExperience(487_000 + 500), 101);
  assert.equal(starFromExperience(487_000 * 5 + 7000 + 5000 * 10), 514);
  assert.equal(starFromExperience(-10), 0);
  assert.equal(starFromExperience(Number.NaN), 0);
});

test('ratio returns numerator when denominator is 0 and rounds to 2 dp', () => {
  assert.equal(ratio(7, 0), 7);
  assert.equal(ratio(0, 0), 0);
  assert.equal(ratio(10, 3), 3.33);
});

test('extractBedwarsStats reads the raw payload and tolerates missing fields', () => {
  const stats = extractBedwarsStats({
    achievements: { bedwars_level: 312 },
    stats: {
      Bedwars: {
        Experience: 1,
        final_kills_bedwars: 4000,
        final_deaths_bedwars: 800,
        wins_bedwars: 1500,
        losses_bedwars: 500,
        beds_broken_bedwars: 2000,
        beds_lost_bedwars: 1000,
        kills_bedwars: 9000,
        deaths_bedwars: 9000,
        winstreak: 12,
      },
    },
  });
  assert.equal(stats.star, 312);
  assert.equal(stats.fkdr, 5);
  assert.equal(stats.wlr, 3);
  assert.equal(stats.bblr, 2);
  assert.equal(stats.kdr, 1);
  assert.equal(stats.winstreak, 12);

  const empty = extractBedwarsStats({});
  assert.equal(empty.star, 0);
  assert.equal(empty.fkdr, 0);
  assert.equal(empty.winstreak, null);
});

test('extractBedwarsStats falls back to Experience when the achievement is missing', () => {
  const stats = extractBedwarsStats({ stats: { Bedwars: { Experience: 487_000 + 500 + 1000 } } });
  assert.equal(stats.star, 102);
});

test('hidden winstreak becomes null', () => {
  const stats = extractBedwarsStats({ stats: { Bedwars: { wins_bedwars: 10 } } });
  assert.equal(stats.winstreak, null);
});

test('rankOf', () => {
  assert.equal(rankOf({}), null);
  assert.equal(rankOf({ packageRank: 'NONE' }), null);
  assert.equal(rankOf({ newPackageRank: 'MVP_PLUS' }), 'MVP+');
  assert.equal(rankOf({ newPackageRank: 'MVP_PLUS', monthlyPackageRank: 'SUPERSTAR' }), 'MVP++');
  assert.equal(rankOf({ rank: 'ADMIN' }), 'ADMIN');
  assert.equal(rankOf({ rank: 'YOUTUBER', newPackageRank: 'MVP_PLUS' }), 'YOUTUBE');
  assert.equal(rankOf({ rank: 'NORMAL', newPackageRank: 'VIP' }), 'VIP');
  assert.equal(rankOf({ prefix: '§c[OWNER]' }), 'OWNER');
});

test('threatLevel thresholds', () => {
  const base = extractBedwarsStats({});
  assert.equal(threatLevel({ ...base, fkdr: 0.5, star: 20 }), 'low');
  assert.equal(threatLevel({ ...base, fkdr: 1.5, star: 50 }), 'medium');
  assert.equal(threatLevel({ ...base, fkdr: 0.9, star: 150 }), 'medium');
  assert.equal(threatLevel({ ...base, fkdr: 3.5, star: 150 }), 'high');
  assert.equal(threatLevel({ ...base, fkdr: 2, star: 350 }), 'high');
  assert.equal(threatLevel({ ...base, fkdr: 9, star: 100 }), 'extreme');
  assert.equal(threatLevel({ ...base, fkdr: 5.5, star: 320 }), 'extreme');
  assert.equal(threatLevel({ ...base, fkdr: 1, star: 700 }), 'extreme');
});
