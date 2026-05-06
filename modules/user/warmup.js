const { pubClient: redis } = require("@project/config/redis");
const { BANNED_USERS_KEY, BANNED_IPS_KEY } = require("@project/utils/const_config");
const User = require("@project/modules/user/model");

async function warmBanCaches() {
  const bannedUsers = await User.find({ isBanned: true })
    .select("name ipAddress")
    .lean();

  if (bannedUsers.length === 0) {
    console.log("Ban cache warm-up: no banned users");
    return;
  }

  const names = bannedUsers.map((u) => u.name);
  const ips = [...new Set(bannedUsers.map((u) => u.ipAddress).filter(Boolean))];

  const pipeline = redis.multi();
  pipeline.sAdd(BANNED_USERS_KEY, names);
  if (ips.length > 0) pipeline.sAdd(BANNED_IPS_KEY, ips);
  await pipeline.exec();

  console.log(
    `Ban cache warm-up: ${names.length} usernames, ${ips.length} IPs loaded into Redis`,
  );
}

module.exports = { warmBanCaches };
