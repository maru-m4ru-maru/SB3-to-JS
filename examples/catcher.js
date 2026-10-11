// Catch the falling stars - a small game written in the js2sb3 dialect of JavaScript.
//   node bin/js2sb3.js examples/catcher.js          ->  examples/catcher.sb3 (opens in the Scratch editor)
//   node bin/sb3c.js examples/catcher.sb3 --html    ->  a standalone web page
project({ title: 'Catcher' });

let score = 0;
let lives = 3;
let best = [];          // an array becomes a Scratch list; best[0] is the FIRST item (index 1 in Scratch)

stage({
  costumes: [{ name: 'sky', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="#16213e"/></svg>' }],
}, () => {
  onFlag(() => {
    score = 0;
    lives = 3;
    showVariable(score);
    showVariable(lives);
  });
  onMessage('game over', () => {
    best.push(score);
    stopAll();
  });
});

sprite('Basket', {
  x: 0, y: -150,
  costumes: [{ name: 'basket', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="26"><path d="M0 0 H60 L50 26 H10 Z" fill="#e94560"/></svg>' }],
}, () => {
  onFlag(() => {
    goTo(0, -150);
    forever(() => {
      if (keyPressed('left arrow')) { changeX(-9); }
      if (keyPressed('right arrow')) { changeX(9); }
    });
  });
});

sprite('Star', {
  visible: false,
  costumes: [{ name: 'star', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30"><polygon points="15,1 19,11 29,11 21,18 24,28 15,22 6,28 9,18 1,11 11,11" fill="#ffd460"/></svg>' }],
}, () => {
  function fall(speed) {
    goTo(random(-200, 200), 170);
    show();
    repeatUntil(yPosition() < -165, () => {
      changeY(-speed);
      if (touching('Basket')) {
        score += 1;
        deleteClone();
      }
    });
    lives -= 1;
    if (lives < 1) { broadcast('game over'); }
    deleteClone();
  }

  onFlag(() => {
    hide();
    forever(() => {
      createClone();
      wait(0.7);
    });
  });
  onCloneStart(() => {
    fall(3 + score / 5);
  });
});
