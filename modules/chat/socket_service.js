const { createRoom } = require("@project/socket/roomManager");

async function createSocketRoomsForMatchService(matches) {
  try {
    // Loop through each match
    for (const match of matches) {
      for (const game of match.games) {
        // Check if there are any active stream links for this game
        const activeStreamLinks = game.streamLinks.filter(
          (link) => link.isActive
        );

        if (activeStreamLinks.length > 0) {
          // If there are active stream links, create the chat room
          console.log(`Creating chat room for streamId: ${game._id}`);
          createRoom(game._id.toString()); // Create the room for this game (streamId)
        } else {
          console.log(
            `No active stream links for streamId: ${game._id}. Skipping room creation.`
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
