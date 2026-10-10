'use strict';

// All artwork is drawn locally. Stored covers are ordinary 600 × 800 JPEGs;
// the template ID only enables live title changes in the metadata form.
window.WriterCovers=(()=>{
  const W=600,H=800,serif='"Noto Serif CJK SC","Songti SC","STSong",serif',sans='"Noto Sans CJK SC","PingFang SC",sans-serif';
  const templates=[{id:'ocean',name:'山海'},{id:'orbit',name:'星轨'},{id:'night',name:'夜航'},{id:'blossom',name:'花信'},{id:'neon',name:'霓虹'},{id:'mountain',name:'远山'},{id:'paper',name:'诗笺'},{id:'ripple',name:'波纹'},{id:'garden',name:'绿意'},{id:'dawn',name:'曙光'}];
  const names={zh:['星期三的猫不肯上班','退休魔王的便利店','我在云端捡到一封信','月亮今天不营业','请把春天寄给我','反派只想准时下班','风把答案藏进了口袋','夜航船上没有陌生人','失物招领处的最后一盏灯','山海之间有间小书店','一百零一次逃离剧本','我的邻居是昨日的我','欢迎来到晴天档案馆','给星星写一张请假条','雨停之前不要告别','我们在世界尽头种花','这届神仙有点难带','小镇禁止星期一','末班车开往盛夏','一封来自未来的差评','在黄昏收养一场雪','未完成的远方','海风替我说晚安','下一站，宇宙边缘'],en:['The Moon Is Closed Today','A Day Off for the Villain','The Bookshop Between the Tides','Someone Borrowed Tomorrow','Lost Letters, Found Stars','The Last Light on Platform Nine','Clouds in the Lost and Found','A Small Shop at the End of Time','The Cat Who Cancelled Monday','Please Forward This to Spring','The Lighthouse That Forgot Its Name','One More Summer Before the End','Nobody Sleeps on the Night Boat','A Very Ordinary Apocalypse','The Map of Unfinished Places','The Weather Inside a Letter','We Planted Flowers at the Edge','The Universe Owes Me Coffee','A Postcard from the Wrong Future','The Quiet Department of Miracles','When the Sea Learned to Listen','The Town That Outlawed Mondays','Every Ending Has a Spare Key','Leave a Light for Yesterday']};
  const lastTitle={};
  function randomTitle(language,previous=''){const key=language==='en'?'en':'zh',choices=names[key].filter(title=>title!==previous&&title!==lastTitle[key]),title=choices[Math.floor(Math.random()*choices.length)];lastTitle[key]=title;return title;}
  function canvas(){const value=document.createElement('canvas');value.width=W;value.height=H;const ctx=value.getContext('2d');if(!ctx)throw new Error('无法绘制封面，请重试。');return{canvas:value,ctx};}
  function gradient(ctx,colors,x0=0,y0=0,x1=0,y1=H){const value=ctx.createLinearGradient(x0,y0,x1,y1);colors.forEach((color,index)=>value.addColorStop(index/(colors.length-1),color));return value;}
  function background(ctx,...colors){ctx.fillStyle=colors.length===1?colors[0]:gradient(ctx,colors);ctx.fillRect(0,0,W,H);}
  function line(ctx,points,color,width=1){ctx.beginPath();points.forEach(([x,y],index)=>index?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();}
  function circle(ctx,x,y,r,color){ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();}
  function polygon(ctx,points,color){ctx.beginPath();points.forEach(([x,y],index)=>index?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.closePath();ctx.fillStyle=color;ctx.fill();}
  function curve(ctx,points,color,width=1){ctx.beginPath();ctx.moveTo(...points[0]);for(let index=1;index<points.length;index+=3)ctx.bezierCurveTo(...points[index],...points[index+1],...points[index+2]);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();}
  function random(seed=91){return()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};}
  function grain(ctx,color='rgba(255,255,255,.05)',seed=91){const next=random(seed);ctx.fillStyle=color;for(let i=0;i<1400;i++){const size=next()*1.7+.4;ctx.fillRect(next()*W,next()*H,size,size);}}
  function rule(ctx,x,y,width,color){line(ctx,[[x,y],[x+width,y]],color,1);}
  function label(ctx,kind,x,y,color,align='left'){ctx.font='500 12px '+sans;ctx.fillStyle=color;ctx.textAlign=align;ctx.textBaseline='top';const english=typeof uiLanguage!=='undefined'&&uiLanguage==='en';ctx.fillText(english?(kind==='short'?'SHORT FICTION':'A NOVEL'):(kind==='short'?'短 篇 故 事':'长 篇 小 说'),x,y);}
  function wrap(ctx,text,width){const words=/\s/.test(text)?text.split(/\s+/):Array.from(text),separator=/\s/.test(text)?' ':'';const lines=[];let row='';for(const word of words){const candidate=row+(row?separator:'')+word;if(row&&ctx.measureText(candidate).width>width){lines.push(row);row=word;}else row=candidate;}if(row)lines.push(row);return lines;}
  function title(ctx,value,{x=60,y=80,width=480,size=58,lines=3,color='#fff',font=serif,weight=500,align='left',lineHeight=1.4}={}){
    const text=String(value||'').replace(/\s+/g,' ').trim()||(typeof uiLanguage!=='undefined'&&uiLanguage==='en'?'Untitled':'未命名作品');let rows=[];
    for(;size>=25;size-=2){ctx.font=weight+' '+size+'px '+font;rows=wrap(ctx,text,width);if(rows.length<=lines&&rows.every(row=>ctx.measureText(row).width<=width))break;}
    if(rows.length>lines){rows=rows.slice(0,lines);let last=rows.at(-1);while(last&&ctx.measureText(last+'…').width>width)last=Array.from(last).slice(0,-1).join('');rows[rows.length-1]=last+'…';}
    ctx.textAlign=align;ctx.textBaseline='top';ctx.fillStyle=color;rows.forEach((row,index)=>ctx.fillText(row,x,y+index*size*lineHeight,width));return rows.length*size*lineHeight;
  }
  function ocean(ctx,text,kind){
    background(ctx,'#f2ead8','#a4c9c7','#286c7b');circle(ctx,448,205,64,'#edb477');
    polygon(ctx,[[0,415],[70,335],[142,390],[245,260],[365,385],[465,310],[600,403],[600,800],[0,800]],'#51878d');
    polygon(ctx,[[0,510],[145,405],[245,470],[410,350],[600,490],[600,800],[0,800]],'#236575');
    polygon(ctx,[[0,600],[160,488],[315,580],[470,465],[600,535],[600,800],[0,800]],'#133e55');
    for(let i=0;i<14;i++)curve(ctx,[[0,640+i*11],[160,610+i*12],[370,685+i*9],[600,638+i*12]],'rgba(169,207,207,.22)',1);
    label(ctx,kind,57,58,'#325663');title(ctx,text,{x:55,y:105,width:390,size:60,color:'#173c4c',lines:3});grain(ctx);
  }
  function orbit(ctx,text,kind){
    background(ctx,'#141d37','#1b3052','#335978');const next=random(24);for(let i=0;i<125;i++)circle(ctx,next()*W,next()*H,next()*1.3+.4,'rgba(224,233,240,.66)');
    ctx.save();ctx.translate(415,455);ctx.rotate(-.43);for(let i=0;i<7;i++){ctx.beginPath();ctx.ellipse(0,0,95+i*39,195+i*42,0,0,Math.PI*2);ctx.strokeStyle=i%2?'rgba(209,181,129,.45)':'rgba(185,207,227,.23)';ctx.lineWidth=1;ctx.stroke();}ctx.restore();circle(ctx,412,453,50,'#b9c6cb');circle(ctx,402,442,46,'#d4ddd8');
    rule(ctx,60,60,42,'#bba276');title(ctx,text,{y:108,width:475,size:58,color:'#f1eee4'});label(ctx,kind,60,731,'#b7c9d5');
  }
  function night(ctx,text,kind){
    background(ctx,'#0b2834','#245066','#668589');circle(ctx,444,140,44,'#f1ddaa');
    polygon(ctx,[[0,465],[65,445],[100,459],[159,392],[220,450],[310,420],[390,469],[490,400],[600,451],[600,800],[0,800]],'#193f4a');
    ctx.fillStyle='#456a71';ctx.fillRect(0,490,600,310);for(let i=0;i<24;i++)rule(ctx,320+(i%3)*14,510+i*10,100-(i%5)*11,'rgba(236,212,160,.2)');
    polygon(ctx,[[120,607],[270,607],[243,628],[143,628]],'#132b39');line(ctx,[[198,605],[198,490]],'#d9d9c7',2);polygon(ctx,[[195,493],[195,590],[143,590]],'#e2d9bd');
    title(ctx,text,{x:56,y:92,width:290,size:57,color:'#f4e8cc',lines:4});label(ctx,kind,56,731,'#d8dcd0');grain(ctx);
  }
  function blossom(ctx,text,kind){
    background(ctx,'#f6efe6','#f0ddd4');circle(ctx,492,656,170,'#eabda4');curve(ctx,[[650,95],[405,160],[446,380],[278,585]],'#666951',7);curve(ctx,[[451,260],[335,208],[292,147],[267,80]],'#666951',4);
    [[422,190,18],[386,232,21],[453,300,24],[363,365,19],[334,427,24],[306,508,18],[319,166,16],[285,109,20],[485,146,20],[408,389,16]].forEach(([x,y,r])=>{for(let i=0;i<5;i++){const a=i*Math.PI*2/5;circle(ctx,x+Math.cos(a)*r*.65,y+Math.sin(a)*r*.65,r*.58,'#fbf7ef');}circle(ctx,x,y,3.2,'#b28863');});
    title(ctx,text,{x:57,y:94,width:290,size:57,color:'#5b5146',lines:4,font:serif});rule(ctx,60,689,40,'#a97758');label(ctx,kind,60,728,'#927c68');grain(ctx,'rgba(121,101,80,.045)');
  }
  function neon(ctx,text,kind){
    background(ctx,'#111326','#25324e','#322543');ctx.fillStyle='#1c2540';ctx.fillRect(0,440,600,360);const next=random(55);
    for(let i=0;i<12;i++){const x=i*55-15,h=80+next()*220;ctx.fillStyle=i%2?'#202a43':'#151e34';ctx.fillRect(x,470-h,42,h+160);for(let j=0;j<7;j++){ctx.fillStyle=j%2?'#6c8f9e':'#bc7790';ctx.fillRect(x+8,482-h+j*24,4,10);}}
    for(let i=0;i<12;i++)line(ctx,[[300,440],[-500+i*150,800]],'rgba(124,146,194,.24)',1);for(let i=0;i<12;i++)rule(ctx,0,445+i*i*2.7,600,'rgba(124,146,194,.26)');
    ctx.strokeStyle='#d58ba5';ctx.lineWidth=2;ctx.strokeRect(43,53,514,280);title(ctx,text,{x:68,y:85,width:460,size:57,color:'#eef2f4',font:sans,weight:650});rule(ctx,68,310,55,'#b281a7');label(ctx,kind,56,728,'#c1bed2');grain(ctx);
  }
  function mountain(ctx,text,kind){
    background(ctx,'#e7eadd','#e0e4d5');circle(ctx,444,122,48,'#b7bd99');
    [[390,'#b4c2ac'],[475,'#92aa9e'],[560,'#6d9186'],[655,'#3d706b']].forEach(([y,color],index)=>{ctx.beginPath();ctx.moveTo(0,y);ctx.bezierCurveTo(120,y-120-index*9,200,y+76,310,y-45);ctx.bezierCurveTo(420,y-150,490,y+30,600,y-90);ctx.lineTo(600,800);ctx.lineTo(0,800);ctx.closePath();ctx.fillStyle=color;ctx.fill();});
    label(ctx,kind,55,56,'#637c70');title(ctx,text,{x:52,y:105,width:370,size:58,color:'#2e4b45',lines:3});grain(ctx,'rgba(38,65,51,.045)');
  }
  function paper(ctx,text,kind){
    background(ctx,'#f3f0e8');ctx.fillStyle='#dfe5e5';ctx.fillRect(38,38,524,724);ctx.fillStyle='#f8f6ef';ctx.fillRect(54,54,492,692);for(let i=0;i<19;i++)rule(ctx,88,295+i*20,420,'#dce1dd');
    ctx.fillStyle='#244b66';ctx.fillRect(87,91,13,120);title(ctx,text,{x:124,y:98,width:365,size:48,color:'#25445a',lines:3,font:serif});
    ctx.fillStyle='#ae634e';ctx.fillRect(444,646,43,43);ctx.strokeStyle='#f4e9db';ctx.lineWidth=1;ctx.strokeRect(450,652,31,31);line(ctx,[[457,659],[457,676],[474,676],[474,659],[457,659]],'#f4e9db',1);label(ctx,kind,88,699,'#7c8d94');grain(ctx,'rgba(93,96,80,.055)');
  }
  function ripple(ctx,text,kind){
    background(ctx,'#c5dde4','#5f95ae','#1e5373');for(let i=0;i<24;i++){ctx.beginPath();ctx.ellipse(415,490,24+i*21,13+i*17,0,0,Math.PI*2);ctx.strokeStyle=i%3===0?'rgba(231,245,245,.55)':'rgba(218,238,242,.23)';ctx.lineWidth=1;ctx.stroke();}
    title(ctx,text,{x:54,y:93,width:470,size:60,color:'#153f5c',lines:3});rule(ctx,56,58,42,'#426d82');label(ctx,kind,56,730,'#d8ebed');grain(ctx);
  }
  function garden(ctx,text,kind){
    background(ctx,'#0b4945','#30786c');const leaves=[[70,630,-.5,110],[515,230,.6,140],[500,675,1.2,145],[85,305,-1,150],[300,60,.4,120]];
    leaves.forEach(([x,y,angle,size],index)=>{ctx.save();ctx.translate(x,y);ctx.rotate(angle);ctx.beginPath();ctx.moveTo(0,size);ctx.bezierCurveTo(-size*.7,size*.4,-size*.7,-size*.5,0,-size);ctx.bezierCurveTo(size*.7,-size*.5,size*.7,size*.4,0,size);ctx.fillStyle=index%2?'#7eac83':'#559b85';ctx.fill();line(ctx,[[0,size],[0,-size]],'rgba(210,230,187,.44)',1);ctx.restore();});
    ctx.fillStyle='#f3ebd7';ctx.fillRect(94,255,412,320);rule(ctx,126,292,35,'#718574');title(ctx,text,{x:128,y:328,width:345,size:48,color:'#2d5c51',lines:3});label(ctx,kind,128,532,'#7a8d73');grain(ctx);
  }
  function dawn(ctx,text,kind){
    background(ctx,'#f0d2b5','#e9ae96','#a57685');circle(ctx,300,470,157,'#f7ddac');ctx.fillStyle='#bc8a87';for(let i=0;i<10;i++)ctx.fillRect(0,486+i*19,600,5+i*1.6);
    polygon(ctx,[[0,640],[170,580],[330,670],[490,600],[600,645],[600,800],[0,800]],'#705d73');polygon(ctx,[[0,719],[145,656],[295,747],[510,676],[600,722],[600,800],[0,800]],'#4c516a');
    title(ctx,text,{x:300,y:89,width:480,size:58,color:'#614e5b',align:'center',lines:3});label(ctx,kind,300,55,'#9d7872','center');grain(ctx);
  }
  const painters={ocean,orbit,night,blossom,neon,mountain,paper,ripple,garden,dawn};
  function render(templateId,text,kind='long'){if(!Object.hasOwn(painters,templateId))throw new Error('封面模板不存在。');const value=canvas();painters[templateId](value.ctx,text,kind);return value.canvas.toDataURL('image/jpeg',.88);}
  async function composeImage(dataURL,text){
    if(typeof dataURL!=='string'||dataURL.length>16*1024*1024||!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(dataURL))throw new Error('这张图片无法读取。');
    const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('这张图片无法读取。'));image.src=dataURL;});
    const width=image.naturalWidth||image.width,height=image.naturalHeight||image.height;if(!width||!height||width*height>100000000)throw new Error('这张图片无法读取。');const value=canvas(),ctx=value.ctx,scale=Math.max(W/width,H/height);ctx.drawImage(image,(W-width*scale)/2,(H-height*scale)/2,width*scale,height*scale);ctx.fillStyle=gradient(ctx,['rgba(5,18,32,0)','rgba(5,18,32,.82)'],0,350,0,800);ctx.fillRect(0,350,W,450);title(ctx,text,{x:52,y:570,width:495,size:52,color:'#fff',font:serif,lines:3});return value.canvas.toDataURL('image/jpeg',.88);
  }
  return Object.freeze({templates:Object.freeze(templates.map(Object.freeze)),render,composeImage,randomTitle});
})();
