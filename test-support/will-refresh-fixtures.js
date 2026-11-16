'use strict';
// Derived test cases, NOT new captures. Poster identity/rating markup is verbatim from
// test/fixtures/films-page-chrome.html (William, page 2). Only count/pagination/rating
// absence are controlled here. Following markup is the existing Marco parser fixture;
// its links are renamed to test Will traversal, not evidence of whom Will follows.
const fs=require('node:fs'),path=require('node:path');
const read=name=>fs.readFileSync(path.join(__dirname,'../test/fixtures',name),'utf8');
function films({unrated=false,next=null}={}) {
 let html=read('films-page-chrome.html');
 const count=(html.match(/<li class="griditem">/g)||[]).length;
 html=html.replace('1,696&nbsp;films',`${count}&nbsp;films`).replace(/<div class="pagination">[\s\S]*<\/body>/,'</body>');
 if(unrated) html=html.replace(/rated-8/g,'unrated');
 if(next) html=html.replace('</body>',`<a class="next" href="${next}">Older</a></body>`);
 return html;
}
function following(){return read('following-page.html').replaceAll('/mgusmao/','/friend-a/').replace(/<div class="pagination">[\s\S]*<\/body>/,'</body>');}
module.exports={films,following};

// Same captured watchlist grid; count and pagination are controlled test inputs.
function watchlist({user='friend_a',next=null}={}) {
 let html=read('watchlist-live-page.html');
 const count=(html.match(/<li class="griditem">/g)||[]).length;
 html=html.replace('564&nbsp;films',`${count}&nbsp;films`).replaceAll('mgusmao',user).replace(/<div class="pagination">[\s\S]*<\/body>/,'</body>');
 if(next)html=html.replace('</body>',`<a class="next" href="${next}">Older</a></body>`);
 return html;
}
module.exports.watchlist=watchlist;
