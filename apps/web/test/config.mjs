/** La prueba visual usa seis opciones sin rasgos aleatorios y un reloj breve. */
import { ENEMIES, GAME_CONFIG } from "@dungeon/shared";
GAME_CONFIG.promptPreviewSeconds = 1;
GAME_CONFIG.questionTimeSeconds = 3;
for (const enemy of ENEMIES) enemy.trait = null;
