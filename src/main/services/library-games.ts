import { db, gamesSublevel } from "@main/level";
import type { Game } from "@types";
import { createLibraryGamesSnapshot } from "./library-games-snapshot";

const snapshot = createLibraryGamesSnapshot<Game>(db, gamesSublevel);
export const readLibraryGames = () => snapshot.read();
