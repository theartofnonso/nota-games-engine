import { supabase } from '../config/supabase.js';
import { CHANNELS } from './channels.js';

async function send() {
  const channel =
    supabase.channel(
      CHANNELS.motion(
        "test-session"
      )
    );

  await channel.subscribe();

  await channel.send({
    type: "broadcast",
    event: "motion_batch",

    payload: {
      playerId: "123",
      playerName: "Tolu",

      teamId: "red",

      samples: [
        {
          timestamp: Date.now(),
          x: 2,
          y: 1,
          z: 4,
        },
      ],
    },
  });

  console.log("Sent");
}

send();