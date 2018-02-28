/*
Heavily based off Nick Marus' node-flint framework helloworld example: https://github.com/nmarus/flint
*/
/*jshint esversion: 6 */  // Help out our linter

var Flint = require('node-flint');
var webhook = require('node-flint/webhook');
var express = require('express');
var bodyParser = require('body-parser');
var app = express();

// Set the config vars for the environment we are running in
var config = {};
if ((process.env.WEBHOOK) && (process.env.TOKEN)) {
  config.webhookUrl = process.env.WEBHOOK;
  config.token = process.env.TOKEN;
} else {
  // sets config and the mongo DB vars for dev instances.
  config = require("./config.json");
}
if (process.env.PORT) {
  config.port = process.env.PORT;
}


// Keep track about "stuff" I learn from the users in a hosted Mongo DB
var mongo_client = require('mongodb').MongoClient;
var mConfig = {};
if ((process.env.MONGO_USER) && (process.env.MONGO_PW)) {
  mConfig.mongoUser = process.env.MONGO_USER;
  mConfig.mongoPass = process.env.MONGO_PW;
  mConfig.mongoUrl = process.env.MONGO_URL;
  mConfig.mongoDb = process.env.MONGO_DB;
} else {
  // sets config and the mongo DB vars for dev instances.
  mConfig = require("./mongo.json");
}
var mCollection = null;
var mongo_collection_name ="cjnMongoCollection";
var mongoUri = 'mongodb://'+mConfig.mongoUser+':'+mConfig.mongoPass+'@'+mConfig.mongoUrl+mConfig.mongoDb+'?ssl=true&replicaSet=Cluster0-shard-0&authSource=admin';

mongo_client.connect(mongoUri, function(err, db) {
  if (err) {return console.log('Error connecting to Mongo '+ err.message);}
  db.collection(mongo_collection_name, function(err, collection) {
    if (err) {return console.log('Error getting Mongo collection  '+ err.message);}
    mCollection = collection;
    mongo_client_ready = true;
    flint.debug('Database connection for persistent storage is ready.');
  });
});

// Keep track about "stuff" I learn from the users in a Mongo DB and in the bots memory store
var botUserInfo = {
  _id: null,
  askedExit: false,
  trackTickets: []
};

//app.use(bodyParser.json());
app.use(bodyParser.json({limit: '50mb'}));


// Helper classes for dealing with Jira Webhook payload
var jiraEventHandler = require("./jira-event.js");

var jpsBot = null;
// init flint
var flint = new Flint(config);
flint.start();
flint.messageFormat = 'markdown';
console.log("Starting flint, please wait...");

flint.on("initialized", function() {
  console.log("Flint initialized successfully! [Press CTRL-C to quit]");
});


flint.on('spawn', function(bot){
  // An instance of the bot has been added to a room
  console.log('new bot spawned in room: %s with %s', bot.room.id, bot.isDirectTo);

  // Say hello to the room
  if(bot.isGroup) {
     bot.say("Hi! Sorry, I only work in one on one rooms at the moment.  Goodbye.");
     bot.exit();
     return;
  } else {
    if (bot.isDirectTo === 'jshipher@cisco.com') {
      // Too chatty on Heroku
      // bot.say('**ACTIVE**');
      jpsBot = bot;
    } else {
      flint.debug(bot.isDirectTo + ' is in a space with TropoJiraNotifier Bot');
    }
    newUser = botUserInfo ;
    if (mCollection) {
      mCollection.findOne({'_id': bot.isDirectTo}, function(err, reply){
        if (err) {return console.log("Can't communicate with db:" + err.message);}
        if (reply !== null) {
          flint.debug('User config exists in DB, so this is an existing room.  Bot has restarted.');
          newUser = reply;
        } else {
          flint.debug("This is a new room.  Storing data about this user");
          newUser._id = bot.isDirectTo;
          mCollection.insert(newUser, {w:1}, function(err, result) {
            if (err) {return console.log("Can't add new user "+bot.isDirectTo+" to db:" + err.message);}
          });
          postInstructions(bot, /*status_only=*/false, /*instructions_only=*/true);
          updateJp(bot.isDirectTo + ' created a space with TropoJiraNotifier Bot');
        }
        // Set the user specific configuration in this just spwaned instance of the  bot
        flint.debug('Setting these user configurations in the bot object');
        flint.debug(newUser);
        bot.store('user_config', newUser);
      });
    } else {
      console.error("Can't access persistent data so many not have correct settings for user " + bot.isDirectTo);
    }
    return;
  }
});

function updateJp(message, listAll=false) {
  try {
    jpsBot.say(message);
    if (listAll) {
      flint.bots.forEach(function(bot) {
        jpsBot.say({'markdown': "* " + bot.isDirectTo});
      });
    }
  } catch (e) {
    flint.debug('Unable to spark JP the news ' + message);
    flint.debug('Reason: ' + e.message);
  }
}

function postInstructions(bot, status_only=false, instructions_only=false) {
  if (!status_only) {
  bot.say("I will look for Jira tickets that are assigned to, or that mention " +
        bot.isDirectTo + " and notify you so you can check out the ticket immediately." +
        "\n\nIf you get tired of this service please type the command **shut up** to get me to stop. " +
        'After that you can leave this room.' +
        "\n\nIf you ever want me to start notifying you again, restart a room with me and type **come back**." +
        "\n\nIf you aren't sure if I'm giving you notifications, just type **status**");
  }
  if (!instructions_only) {
    bot.recall('user_config')
      .then(function(userConfig) {
        if (userConfig.askedExit) {
          bot.say("\n\nCurrent Status: Notifications are **disabled**.");
        } else {
          bot.say("\n\nCurrent Status: Notifications are **enabled**.");
        }
        flint.debug('Status for '+ bot.isDirectTo + ': ' + userConfig);
      })
      .catch(function(err) {
        console.error('Unable to get askedExit status for ' + bot.isDirectTo);
        console.error(err.message);
        bot.say("Hmmn. I seem to have a database problem, and can't report my notification status.   Please ask again later.");
      });
  }
}


/****
## Process incoming messages
****/

/* On mention with command
ex User enters @botname /hello, the bot will write back
*/
var responded = false;
var status_words = /^\/?(status|are you (on|working))( |.|$)/i;
flint.hears(status_words, function(bot, trigger) {
  flint.debug('Processing Status Request for ' + bot.isDirectTo);
  postInstructions(bot, /*status_only=*/true);
  responded = true;
});


var hello_words= /^\/?(hello|hi|hey there|hiya)( |.|$)/i;
flint.hears(hello_words, function(bot, trigger) {
  console.log("hello fired");
  bot.say('%s, you said hello to me!', trigger.personDisplayName);
  postInstructions(bot);
  responded = true;
});

/* On mention with command, using other trigger data, can use lite markdown formatting
ex "@botname /whoami"
*/
flint.hears('/whoami', function(bot, trigger) {
  console.log("/whoami fired");
  //the "trigger" parameter gives you access to data about the user who entered the command
  let roomId = "*" + trigger.roomId + "*";
  let roomTitle = "**" + trigger.roomTitle + "**";
  let personEmail = trigger.personEmail;
  let personDisplayName = trigger.personDisplayName;
  let outputString = `${personDisplayName} here is some of your information: \n\n\n **Room:** you are in "${roomTitle}" \n\n\n **Room id:** ${roomId} \n\n\n **Email:** your email on file is *${personEmail}*`;
  bot.say("markdown", outputString);
  responded = true;
});

/* On mention with command arguments
ex User enters @botname /echo phrase, the bot will take the arguments and echo them back
*/
flint.hears('/echo', function(bot, trigger) {
  console.log("/echo fired");
  let phrase = trigger.args.slice(1).join(" ");
  let outputString = `Ok, I'll say it: "${phrase}"`;
  bot.say(outputString);
  responded = true;
});

flint.hears('/roomid', function(bot, trigger) {
  bot.say('This is your room ID', trigger.roomId);
});

var exit_words = /^\/?(exit|goodbye|mute|leave|shut( |-)?up)( |.|$)/i;
flint.hears(exit_words, function(bot, trigger) {
  flint.debug('Processing Exit Request for ' + bot.isDirectTo);
  setAskedExit(bot, mCollection, true);
  updateJp(bot.isDirectTo + ' asked me to turn off notifications');
  responded = true;
});

var return_words = /^\/?(talk to me|return|un( |-)?mute|come( |-)?back)( |.|$)/i;
flint.hears(return_words, function(bot, trigger) {
  flint.debug('Processing Return Request for ' + bot.isDirectTo);
  setAskedExit(bot, mCollection, false);
  updateJp(bot.isDirectTo + ' asked me to start notifying them again');
  responded = true;
});

function setAskedExit(bot, mCollection, exitStatus) {
  bot.recall('user_config')
    .then(function(userConfig) {
      if ((userConfig.askedExit) && (exitStatus === true)) {
        return bot.say('Notifications are already **disabled**.');
      }
      if ((!userConfig.askedExit) && (exitStatus === false)) {
        return bot.say('Notifications are already **enabled**.');
      }
      if (mCollection) {
        mCollection.update({'_id':bot.isDirectTo}, {$set:{'askedExit':exitStatus}}, {w:1}, function(err, result) {
          if (err) {
            console.error("Can't communicate with db:" + err.message);
            return bot.say("Hmmn. I seem to have a database problem.   Please ask again later.");
          }
          userConfig.askedExit = exitStatus;
          bot.store('user_config', userConfig);
          if (exitStatus === true) {
            bot.say("OK.   I won't give you any more updates.  If you want to turn them on again just type **come back**.");
          } else {
            bot.say("OK.   I'll start giving you updates.  If you want to turn them off again just type **shut up**.");
          }
        });
      } else {
        console.log('Unable to store exit request for ' + bot.isDirectTo + ' because DB never properly set up.');
        bot.say("Hmmn. I seem to have a database problem.   Please ask again later.");
      }
    })
    .catch(function(err) {
      console.error('Unable to get quietMode status for ' + bot.isDirectTo);
      console.error(err.message);
      bot.say("Hmmn. I seem to have a database problem.   Please ask again later.");
    });
}


flint.hears('/showjptheusers', function(bot, trigger) {
  updateJp('The following people are using me:', true);
  responded = true;
});

var help_words = /^\/?help/i;
flint.hears(help_words, function(bot, trigger) {
  postInstructions(bot);
  responded = true;
});

// Dump the trigger details to console for any event
flint.hears(/(^| )jpsNodeBot|.*( |.|$)/i, function(bot, trigger) {
//flint.hears('*', function(bot, trigger) {
  //set bot to listen to incoming webhooks based on @mentions in group rooms
  //or any text in a one on one room

  //@ mention removed before further processing for group conversations. @symbol not passed in message
  let text = trigger.text;
  let request = text.replace("jpsNodeBot ",'');
  if (!responded) {
    bot.say('Don\'t know how to respond to "' + text +'"');
  }
  responded = false;
  console.log("Got a message to my bot:" + text);
  //console.log(trigger);
});

/****
## Server config & housekeeping
****/

// Spark webbhook
app.post('/', webhook(flint));
  var server = app.listen(config.port, function () {
  flint.debug('Flint listening on port %s', config.port);
});

// Basic liveness test
app.get('/', function (req, res) {
  res.send('I\'m alive');
});

// Jira webbhook
app.post('/jira', function (req, res) {
  flint.debug('Processing incoming Jira Event');
  //console.log(req.body);
  var jiraEvent = '';
  try {
    jiraEvent = req.body;
    if (typeof jiraEvent.webhookEvent === 'string') {
      jiraEventHandler.processJiraEvent(jiraEvent, flint);
    }
  } catch (e) {
    console.log('Error processing Jira Event Webhook:' + e);
    console.log('Ignoring: '+ jiraEvent);
    res.status(400);
  }
  res.end();
});


// gracefully shutdown (ctrl-c), etc
process.on('SIGINT', sayGoodbye);
process.on('SIGTERM', sayGoodbye);

function sayGoodbye() {
  /* This is too chatty on heroku which goes up and down all the time by design
   *
  updateJp({'markdown': "It looks like I'm going offline for a bit.   I won't be able to " +
            "notify you about anything until I send you a welcome message again." +
            "\n\nI'm afraid you'll have to use other tools to find out what is happening in Jira. " +
            "You still have an email client, don't you?<br><br>**INACTIVE**"});
    *
    */
  flint.debug('stoppping...');
  server.close();
  flint.stop().then(function() {
    process.exit();
  });
}
