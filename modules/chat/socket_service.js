const { createRoom } = require("@project/socket/roomManager");
const { handleMatchStatus } = require("@project/utils");

async function createSocketRoomsForMatchService(matches) {
  try {
    // Loop through each match
    for (const match of matches) {
      for (const game of match.games) {
        // Check if there are any active stream links for this game
        // const activeStreamLinks = game.streamLinks.filter(
        //   (link) => link.isActive
        // );

        // if (activeStreamLinks.length > 0) {
        //   // If there are active stream links, create the chat room
        //   console.log(`Creating chat room for streamId: ${game._id}`);
        //   createRoom(game._id.toString()); // Create the room for this game (streamId)
        // } else {
        //   console.log(
        //     `No active stream links for streamId: ${game._id}. Skipping room creation.`
        //   );
        // }
        const matchStatus = handleMatchStatus({
          isLive: game?.isLive,
          isEnded: game?.isEnded,
          matchDate: game?.matchDate,
        });
        if (matchStatus.isLive || matchStatus?.isLessThan50) {
          // If there are active stream links, create the chat room
          console.log(`Creating chat room for streamId: ${game._id}`);
          await createRoom(game._id.toString(), game?.showViews); // Create the room for this game (streamId)
        } else {
          console.log(
            `No Live Status for streamId: ${game._id}. Skipping room creation.`
          );
        }
      }
    }

    console.log("Room creation process completed.");
    return true;
  } catch (error) {
    console.error("Error creating rooms for matches:", error);
    return null;
  }
}

module.exports = {
  createSocketRoomsForMatchService,
};
