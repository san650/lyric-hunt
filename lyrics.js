// Lyrics corpus and artist registry.
//
// ARTISTS shape:
//   id          — stable kebab-case slug, never changes
//   displayName — what the UI shows (preferred alias / common name)
//   aliases     — every form the band is also known by; used by the
//                 Ruby ingest script (scripts/ingest.rb) to resolve
//                 band headers in the input txt to a canonical id
//
// SONGS shape:
//   id           — stable kebab-case slug
//   artistId     — references ARTISTS.id
//   song         — canonical song title (clean, no "(feat.)" suffix)
//   album        — canonical album title (empty if unknown)
//   year         — release year (null if unknown)
//   songAliases  — alternative spellings/forms; alias matcher is
//                  diacritic-tolerant and accepts substrings already
//   albumAliases — same, for the album
//   fragments    — list of multi-line excerpts the game samples from

const ARTIST_CHOICE_LIMIT = 10;

export const ARTISTS = [
  {
    id: 'cuarteto-de-nos',
    displayName: 'El Cuarteto de Nos',
    aliases: ['El Cuarteto de Nos', 'Cuarteto de Nos', 'El Cuarteto', 'Cuarteto'],
  },
  {
    id: 'redondos',
    displayName: 'Los Redondos',
    aliases: [
      'Los Redondos',
      'Patricio Rey y Sus Redonditos de Ricota',
      'Patricio Rey y Los Redonditos de Ricota',
      'Los Redonditos de Ricota',
      'Redonditos de Ricota',
      'Patricio Rey',
      'Redondos',
      'Redonditos',
    ],
  },
  {
    id: 'la-tabare',
    displayName: 'La Tabaré',
    aliases: ['La Tabaré', 'La Tabare', 'Tabaré', 'Tabare', 'La Tabaré Riverock Banda'],
  },
  {
    id: 'angeles-azules',
    displayName: 'Los Ángeles Azules',
    aliases: ['Los Ángeles Azules', 'Los Angeles Azules', 'Ángeles Azules', 'Angeles Azules'],
  },
  {
    id: 'damas-gratis',
    displayName: 'Damas Gratis',
    aliases: ['Damas Gratis', 'Damas G'],
  },
  {
    id: 'julieta-venegas',
    displayName: 'Julieta Venegas',
    aliases: ['Julieta Venegas', 'Venegas Julieta', 'Julieta', 'Venegas'],
  },
  {
    id: 'ska-p',
    displayName: 'Ska-P',
    aliases: ['Ska-P', 'SkaP', 'Skap', 'Ska P'],
  },
];

export const SONGS = [
  // ── El Cuarteto de Nos ───────────────────────────────────────
  {
    id: 'cuarteto-no-somos-latinos',
    artistId: 'cuarteto-de-nos',
    song: 'No Somos Latinos',
    album: 'Otra Navidad en las Trincheras',
    year: 1994,
    songAliases: ['No Somos Latinos', 'No Soy Latino'],
    albumAliases: ['Otra Navidad en las Trincheras', 'Otra Navidad', 'Trincheras'],
    fragments: [
      'Pensarán que soy medio ladino\nO qué vivo borracho de vino\nQuieren hacerme creer estos cretinos\nQue los uruguayos somos latinos',
      'Si me viera mi abuelito Arsenio\nCantando con acento caribeño',
      'No me jodan más, no somos latinos\nYo me crié acá, en la Suiza del sur',
      'Yo no sé bailar ni cumbia ni salsa\nNi me escapé de Cuba en una balsa\nMe parió en Montevideo mi mami\nYo no quiero ir a vivir a Miami',
      'En Colombia me decían "gringo"\nO "alemán" en Santo Domingo',
      'Y cuando leí "Las venas abiertas"\nQue era un bodrio me di cuenta\nA la cuarta hoja me dormí',
      'Prefiero hablar con un filósofo sueco\nQue con un indio guatemalteco\nY tengo más en común con un rumano\nQue con un cholo boliviano',
    ],
  },
  {
    id: 'cuarteto-monei',
    artistId: 'cuarteto-de-nos',
    song: 'Monei',
    album: 'El Tren Bala',
    year: 1996,
    songAliases: ['Monei', 'Money', 'Plata'],
    albumAliases: ['El Tren Bala', 'Tren Bala'],
    fragments: [
      'Yo quería en Carrasco una mansión\nPero solo conseguí un ranchito en Casabó',
      'Yo quería andar en un Meredes Benz\nY ahora solo ando en un 126',
      'Soy negado viejo y siempre lo sabrán\nComo decía aquel viejo refrán\nEl que nace mona Chita nunca llega a ser Tarzán',
      'Yo quería tomar Sol en el Caribe\nY por ahora solo surfo en la playa Ramirez',
      'Yo quería ir a las fiestas del jet set\nPero a los bailes del Coco fue a dónde yo más llegué',
      'Como en la parábola de Rodó\nEl que nace pa letrina nuca llega a water cló',
      'Yo quería vestirme en Christian Dior\nY no este buzo apolillado que mi abuela me tejió',
      'Yo quería comer caviar y faisán\nY no sacarme de los dientes el perejil de un choripán',
    ],
  },

  // ── Los Redondos ────────────────────────────────────────────
  {
    id: 'redondos-un-poco-de-amor-frances',
    artistId: 'redondos',
    song: 'Un Poco de Amor Francés',
    album: 'Un Baión para el Ojo Idiota',
    year: 1988,
    songAliases: ['Un Poco de Amor Francés', 'Un Poco de Amor Frances', 'Amor Francés', 'Amor Frances'],
    albumAliases: ['Un Baión para el Ojo Idiota', 'Un Baion para el Ojo Idiota', 'Un Baión', 'Baión', 'Baion'],
    fragments: [
      'Una tipa rapaz, como te gusta a vos\nEsa tipa vino a consolarte',
      'Un poco de amor francés no muerde su lengua, no\nNo es sincera, pero te gusta oírla',
      'Es una linda ración\nCon un defecto, con uno o dos\nY es un cóctel que no se mezcla solo',
      'Quiere, si quiere más\nYa no la engatusás\nEs una copa de lo mejor\nCuando se ríe',
      'El lujo es vulgaridad, dijo, y me conquistó\nDe esa miel no comen las hormigas',
    ],
  },
  {
    id: 'redondos-de-estos-polvos-futuros-lodos',
    artistId: 'redondos',
    song: 'De Estos Polvos Futuros Lodos',
    album: 'Lobo Suelto / Cordero Atado',
    year: 1993,
    songAliases: ['De Estos Polvos Futuros Lodos', 'Polvos Futuros Lodos', 'El Perro Bobi'],
    albumAliases: ['Lobo Suelto', 'Cordero Atado', 'Lobo Suelto / Cordero Atado'],
    fragments: [
      'El Perro Bobi es\nUn servicio de amor a todo rock\nCanta como un león\nPero es el más salmón de la ciudad',
      'Chunga combinación de polvos\nQue darán lodos después\nMágico inter-terror más arma blanca\nEn cruda pasión',
      'Una papela por el walkman\nQue chorizó tu hermanito\nEl perro cruzó los pies\nSu sonrisa ofertó y la vendió',
    ],
  },
  {
    id: 'redondos-la-bestia-pop',
    artistId: 'redondos',
    song: 'La Bestia Pop',
    album: 'Gulp!',
    year: 1985,
    songAliases: ['La Bestia Pop', 'Bestia Pop'],
    albumAliases: ['Gulp!', 'Gulp'],
    fragments: [
      'Mi héroe es la gran bestia pop\nQue enciende, en sueños, la vigilia\nY antes que cuente diez, dormirá',
      'A brillar, mi amor\nVamos a brillar, mi amor',
      'Mi amigo está grogui sin destilar\nPero yo sé que hay caballos que\nSe mueren potros sin galopar',
      'Voy a bailar el rock del rico Luna Park\nY atomizar la butaca y brillar\nComo mi héroe, la gran bestia pop',
    ],
  },
  {
    id: 'redondos-tarea-fina',
    artistId: 'redondos',
    song: 'Tarea Fina',
    album: 'La Mosca y la Sopa',
    year: 1991,
    songAliases: ['Tarea Fina'],
    albumAliases: ['La Mosca y la Sopa', 'La Mosca', 'La Sopa'],
    fragments: [
      'Quemando la turbina\nTe escapas\n¿Vas a volver a herirme\nOtra vez?',
      'En tu ternura, está acechándome\nUna buena traición de mujer\nQue echa hielo y brasas en mi corazón',
      'Un auto guapo va a venir por vos\nY nada va a cambiar\nVas a vivir en el Delta, en un lanchón\nBuscando de qué reír',
      'Con las piernas más bonitas\nLas más lindas piernas que vi\nY un juego rico de amores\nCaída libre para dos',
    ],
  },
  {
    id: 'redondos-esa-estrella-era-mi-lujo',
    artistId: 'redondos',
    song: 'Esa Estrella Era Mi Lujo',
    album: 'Oktubre',
    year: 1986,
    songAliases: ['Esa Estrella Era Mi Lujo', 'Era Mi Lujo'],
    albumAliases: ['Oktubre', 'Octubre'],
    fragments: [
      '¿Era todo?, pregunté\nSoy un iluso\nNo nos dimos nada más\nSolo un buen gesto',
      'Mordí el anzuelo una vez más\nSiempre un iluso\nNuestra estrella se agotó\nY era mi lujo',
      'Ella fue, por esa vez\nMi héroe vivo, ¡bah!\nFue mi único héroe en este lío\nLa más linda del amor\nQue un tonto ha visto soñar',
    ],
  },
  {
    id: 'redondos-un-angel-para-tu-soledad',
    artistId: 'redondos',
    song: 'Un Ángel Para Tu Soledad',
    album: 'Oktubre',
    year: 1986,
    songAliases: ['Un Ángel Para Tu Soledad', 'Un Angel Para Tu Soledad', 'Ángel Para Tu Soledad'],
    albumAliases: ['Oktubre', 'Octubre'],
    fragments: [
      'Ya sufriste cosas mejores que estas\nY vas a andar esta ruta hoy cuando anochezca',
      'Tu esqueleto te trajo hasta aquí\nCon un cuerpo hambriento, veloz\nY aquí, gracias a Dios\nUno no cree en lo que oye',
      'Ángel de la soledad\nY de la desolación\nPreso de tu ilusión, vas a bailar',
      'Alguna vez, quizás, se te va la mano\nY las llamas en pena invaden tu cuerpo\nY caés en manos del ángel de la soledad',
    ],
  },

  // ── La Tabaré ───────────────────────────────────────────────
  {
    id: 'la-tabare-alegris',
    artistId: 'la-tabare',
    song: 'Alegrís',
    album: '',
    year: null,
    songAliases: ['Alegrís', 'Alegris'],
    albumAliases: [],
    fragments: [
      'Voy... Por ahí\nSomos tantos desencuentros\nCallejeando por el centro\nAlmas de ciudad por dentro\nY zás... Me perdí',
      'Ya ni se en que bocacalle\nQue se callen las bocinas\nY esas bocas de oficina',
      'La alegria de los vagabundos\nQue traspasan este mudo\nSin entrar en el',
      'Carcajada a carcajada\nLa ciudad es una pavada\nLlena de gente apurada',
      'Voy por 18 comiendo bizcochos\nAgarro para el puerto\nEl bajo esta desierto',
    ],
  },
  {
    id: 'la-tabare-acicaladas-alas-alicaidas',
    artistId: 'la-tabare',
    song: 'Acicaladas Alas Alicaídas',
    album: '',
    year: null,
    songAliases: ['Acicaladas Alas Alicaídas', 'Acicaladas Alas Alicaidas', 'Alas Alicaídas'],
    albumAliases: [],
    fragments: [
      'Casi tu mirada, casi aquello\nCasi nada bello en mi.\nUn atardece, la playa\nY pretender que vaya casi a mil',
      'Piña, pica, pito, pucha, ¡pum!\nPena, pana, pene, pompas, plus\nNo me trates mal.\nNo me grites así',
      'Paso amor, peso amor, pozo\nAmordazado\nAmorfo, amoral, ¡a morder el polvo!\nAmoratado',
      'Hambre, sangre, calambre, alambre\nDe púas.\nShoping, zaping, casting, fucking\nAll you need is love',
    ],
  },
  {
    id: 'la-tabare-contrapunto',
    artistId: 'la-tabare',
    song: 'Contrapunto',
    album: '',
    year: null,
    songAliases: ['Contrapunto'],
    albumAliases: [],
    fragments: [
      'Lo quiero invitar compadre\nA cantar por lo que es nuestro\nPorque, le juro, es siniestro\nEl ver nacer como hongos',
      'Tropicalero es traición\nTraición es nieve en enero.',
      'Mugre por televisión\nY la radio es pura conga.\nSi quieren algo criollo:\nNada mejor que milonga.',
      'Porque en la vida tenés dos opciones:\nO echás suerte o echás culo\nSi echás suerte: Buena taba\nSi echás culo:... Jodete',
      'Un jardín desflorado\nUna luna hecha mierda contra el cielo\nNéctar de rocío en tus lágrimas',
    ],
  },
  {
    id: 'la-tabare-distopia-en-blues',
    artistId: 'la-tabare',
    song: 'Distopía En Blues',
    album: '',
    year: null,
    songAliases: ['Distopía En Blues', 'Distopia En Blues', 'Distopía', 'Distopia'],
    albumAliases: [],
    fragments: [
      'El mundo se queda reseco\nSin agua\nY oímos el eco\nDe toda esta fragua',
      'La culpa sin dudas\nLa tiene la gente\nTan maeducada\nTan desobediente\nQue no cierra la canilla\nAl lavarse los dientes',
      'No creo que los obreros\nCuando la tarde calienta\nLaburando en pleno enero\nUsen protector cuarenta',
      'El mundo está destruído, mi amor\nY vamos a caer rendidos, nos dicen\nQue no es porque, en algún lado\nCerdos y sórdidos empresariados',
    ],
  },
  {
    id: 'la-tabare-la-enemistad',
    artistId: 'la-tabare',
    song: 'La Enemistad',
    album: '',
    year: null,
    songAliases: ['La Enemistad', 'Enemistad'],
    albumAliases: [],
    fragments: [
      'Atrás de las botellas\nNuestra rubia mireya\nEn un rincón',
      'Eso como patadas en los huevos\nComo los besos, que volaron\nLa amistad y nos dejaron\nPresos de la resignación',
      'Acodado al tablero\nBebiendo el aguacero\nDel perdón',
      'Perdí tantos amigos\nMirándome el ombligo\nSin condón',
    ],
  },
  {
    id: 'la-tabare-que-noche-aquella',
    artistId: 'la-tabare',
    song: 'Que Nochen La de Aquel Día',
    album: '',
    year: null,
    songAliases: ['Que Nochen La de Aquel Día', 'Que Noche La de Aquel Día', 'Que Nochen La de Aquel Dia'],
    albumAliases: [],
    fragments: [
      'Volvés pa´trás\nVos cada vez\nQue ves que vos\nCreés que te vas...\nNo entiendo.',
      'Desabrochando broches en cuartos de hotel\nHundiendo a troches y moche barcos de papel\n¡Que noche aquella noche la del día aquel!',
      'No entiendo por que no entiendo\nAlgunas cosas sencillas:\n¿Por qué nos sentamos en sillas?\n¿Por qué para andar un rato\nNos ponemos un par de zapatos?',
      'Fantoche buda conectado vía antel\nProfeta del derroche de amor a granel',
    ],
  },

  // ── Ska-P ───────────────────────────────────────────────────
  {
    id: 'ska-p-el-vals-del-obrero',
    artistId: 'ska-p',
    song: 'El Vals Del Obrero',
    album: 'El Vals del Obrero',
    year: 1996,
    songAliases: ['El Vals Del Obrero', 'Vals Del Obrero'],
    albumAliases: ['El Vals del Obrero', 'Vals del Obrero'],
    fragments: [
      'Orgulloso de estar entre el proletariado\nEs difícil llegar a fin de mes\nY tener que sudar y sudar\nPa\' ganar nuestro pan',
      'Este es mi sitio, esta es mi gente\nSomos obreros, la clase preferente',
      'Sí señor, la revolución\nSí señor, sí señor, somos la revolución\nTu enemigo es el patrón',
      'Feliz el empresario, más callos en mis manos\nMis riñones van a reventar\nNo tengo un puto duro pero sigo cotizando',
    ],
  },
  {
    id: 'ska-p-mis-colegas',
    artistId: 'ska-p',
    song: 'Mis Colegas',
    album: 'Eurosis',
    year: 1998,
    songAliases: ['Mis Colegas'],
    albumAliases: ['Eurosis'],
    fragments: [
      'Vas caminando despacio\nSin ganas de sonreír, de sonreír\nHemos quedado en el barrio\nUnos litros y cien duros de hachís',
      'Han pasado 10 años\nMis colegas, ¿dónde están?\nEl que no anda en el Mako\nHace poco lo acabaron de enterrar\nLa heroína no acudió a su funeral',
      'Eh, chaval, siempre a la sombra de la sociedad\nSomos la causa de su malestar\nEscúpele al sistema y nunca dejes de molestar',
      'Qué te ha pasado, princesa\nQue no te veo sonreír... Sonreír\nAún no tienes tu dosis\nPor la noche te tienes que prostituir',
    ],
  },
  {
    id: 'ska-p-cannabis',
    artistId: 'ska-p',
    song: 'Cannabis',
    album: 'Eurosis',
    year: 1998,
    songAliases: ['Cannabis'],
    albumAliases: ['Eurosis'],
    fragments: [
      'Y saco un papelillo, me preparo un cigarrillo\nY una china pa\'l canuto de hachís\nSaca ya la china, tron; venga ya esa china, tron',
      'Lega-legalización (cannabis)\nDe calidad y barato\nLega-legalización (cannabis)\nBasta de prohibición',
      'En Chueca, en La Latina, no hay en Tirso de Molina\nNi en Vallecas, ni siquiera en Chamberí',
      'Sin cortarme un pelo, yo quiero mi caramelo\nVoy corriendo buscando a mi amigo Alí',
    ],
  },

  // ── Julieta Venegas ─────────────────────────────────────────
  {
    id: 'julieta-venegas-limon-y-sal',
    artistId: 'julieta-venegas',
    song: 'Limón y Sal',
    album: 'Limón y Sal',
    year: 2006,
    songAliases: ['Limón y Sal', 'Limon y Sal'],
    albumAliases: ['Limón y Sal', 'Limon y Sal'],
    fragments: [
      'Tengo que confesar que a veces\nNo me gusta tu forma de ser\nLuego te me desapareces\nY no entiendo muy bien por qué',
      'No dices nada romántico\nCuando llega el atardecer\nTe pones de un humor extraño\nCon cada luna llena al mes',
      'Yo te quiero con limón y sal\nYo te quiero tal y como estás\nNo hace falta cambiarte nada',
      'Tengo que confesarte ahora\nNunca creí en la felicidad\nA veces, algo se le parece\nPero es pura casualidad',
    ],
  },
  {
    id: 'julieta-venegas-me-voy',
    artistId: 'julieta-venegas',
    song: 'Me Voy',
    album: 'Limón y Sal',
    year: 2006,
    songAliases: ['Me Voy'],
    albumAliases: ['Limón y Sal', 'Limon y Sal'],
    fragments: [
      'Porque no\nSupiste entender a mi corazón\nLo que había en él, porque no\nTuviste el valor de ver quién soy',
      'No voy a llorar y decir\nQue no merezco esto, porque\nEs probable que\nLo merezco, pero no lo quiero, por eso, me voy',
      'Qué lástima, pero adiós\nMe despido de ti y me voy\nQué lástima, pero adiós\nMe despido de ti',
      'Yo, que pensé\nNunca me iría de ti, que es amor\nDel bueno, de toda la vida, pero\nHoy, entendí que no hay suficiente para los dos',
    ],
  },
  {
    id: 'julieta-venegas-eres-para-mi',
    artistId: 'julieta-venegas',
    song: 'Eres Para Mí',
    album: 'Limón y Sal',
    year: 2006,
    songAliases: ['Eres Para Mí', 'Eres Para Mi'],
    albumAliases: ['Limón y Sal', 'Limon y Sal'],
    fragments: [
      'Sería mejor empezar otra vez\nPero eso ya sé que no se puede\nVas a decirme que es imposible\nPero, por lo menos, déjame que lo intente',
      'Aprendí a sacarle jugo a mis defectos\nY me va mejor desde que deje de odiarlo',
      'Caminando yo en tus labios por la noche\nPor en medio de la calle\nEstoy pensando\nSi me quieres, no me falles',
      'Eres para mí\nMe lo ha dicho el viento\nEres para mí\nLo oigo todo el tiempo',
      'Soy de tierra con el agua\nLlego al cielo, dame tu aire\nY somos fuego y deseo',
    ],
  },
  {
    id: 'julieta-venegas-perfecta',
    artistId: 'julieta-venegas',
    song: 'Perfecta',
    album: '',
    year: null,
    songAliases: ['Perfecta'],
    albumAliases: [],
    fragments: [
      'Tan pronto yo te vi\nNo pude descubrir\nEl amor a primera vista no funciona en mí',
      'Éramos tan buenos amigos hasta hoy\nQue yo probé tu desempeño en el amor',
      'Solo tú, no necesito más\nTe adoraría lo que dura la eternidad\nDebes ser perfecta para\nPerfecto para',
      '¿Cómo fue que de papel cambié?\nEras mi amiga y ahora eres mi mujer',
    ],
  },
  {
    id: 'julieta-venegas-no-me-importa-el-dinero',
    artistId: 'julieta-venegas',
    song: 'No Me Importa El Dinero',
    album: '',
    year: null,
    songAliases: ['No Me Importa El Dinero', 'No Me Importa el Dinero'],
    albumAliases: [],
    fragments: [
      'Me dijeron que llamaste, pero ya me había ido\nPues salimos más temprano del taller\nYo me vine caminando para no gastar dinero',
      'Menos mal que solo es eso\nSentí alivio, lo confieso\nTuve miedo de que fuera otra mujer',
      'A mí no me importa el dinero\nTengo lo que yo más quiero a mi lado\nSoy tu fiel compañera',
      'Sos mi escudo ante el miedo\nY aunque se derrumbe el cielo\nNunca vas a estar solo\nPorque siempre estaré',
    ],
  },
];

// ── Lookups ──────────────────────────────────────────────────────
export const findArtist = (id) => ARTISTS.find((a) => a.id === id);
export const findSong   = (id) => SONGS.find((s) => s.id === id);
export const artistOf   = (songId) => findArtist(findSong(songId).artistId);

// ── Normalization + matching ─────────────────────────────────────
const norm = (s) =>
  (s ?? '')
    .toString()
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[.,;:!?¡¿"'’‘“”\-_/\\()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const matches = (guess, canonical, aliases) => {
  const g = norm(guess);
  if (!g || g.length < 2) return false;
  const candidates = [canonical, ...aliases].map(norm);
  for (const c of candidates) {
    if (!c) continue;
    if (c === g) return true;
    if (c.includes(g) && g.length >= Math.max(4, Math.floor(c.length * 0.5))) return true;
    if (g.includes(c) && c.length >= 4) return true;
  }
  return false;
};

// Returns 'song' | 'album' | null. The user types one thing; either match
// earns the bonus, with the matched kind reported for the reveal panel.
export const checkBonus = (guess, song) => {
  if (matches(guess, song.song,  song.songAliases))  return 'song';
  if (matches(guess, song.album, song.albumAliases)) return 'album';
  return null;
};

// ── Sampling ─────────────────────────────────────────────────────
const shuffle = (a) => {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
};

const allPairs = () => {
  const out = [];
  for (const s of SONGS) for (let i = 0; i < s.fragments.length; i++) {
    out.push({ songId: s.id, fragmentId: i });
  }
  return out;
};

export const pickFragment = (seenKeys = []) => {
  const all = allPairs();
  let available = all.filter((p) => !seenKeys.includes(`${p.songId}:${p.fragmentId}`));
  if (available.length === 0) available = all;
  const pick = available[Math.floor(Math.random() * available.length)];
  const song = SONGS.find((s) => s.id === pick.songId);
  return {
    songId: song.id,
    fragmentId: pick.fragmentId,
    fragment: song.fragments[pick.fragmentId],
  };
};

// For a piece, decide which artist chips to show. Below the threshold,
// every artist appears in shuffled order; above it, the correct artist
// plus a random sample of decoys, also shuffled.
export const pickArtistChoices = (correctArtistId) => {
  if (ARTISTS.length <= ARTIST_CHOICE_LIMIT) {
    return shuffle(ARTISTS).map((a) => a.id);
  }
  const correct = findArtist(correctArtistId);
  const others  = ARTISTS.filter((a) => a.id !== correctArtistId);
  const picks   = [correct, ...shuffle(others).slice(0, ARTIST_CHOICE_LIMIT - 1)];
  return shuffle(picks).map((a) => a.id);
};
