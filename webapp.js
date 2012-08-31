// Strider Simple Worker
// Niall O'Higgins 2012
//
// A simple, in-process worker implementation for Strider.
//

var exec = require('child_process').exec
var gitane = require('gitane')
var gumshoe = require('gumshoe')
var path = require('path')
var spawn = require('child_process').spawn
var Step = require('step')

// Built-in rules for project-type detection
var DEFAULT_PROJECT_TYPE_RULES = [

  // Node
  {filename:"package.json", grep:/express/i, language:"node.js", framework:"express", prepare:"npm install", test:"npm test", start:"npm start"},
  {filename:"package.json", grep:/connect/i, language:"node.js", framework:"connect", prepare:"npm install", test:"npm test", start:"npm start"},
  {filename:"package.json", exists:true, language:"node.js", framework:null, prepare:"npm install", test:"npm test", start:"npm start"},
  // Python
  {filename:"setup.py", grep:/pyramid/i, language:"python", framework:"pyramid"},
  {filename:"manage.py", grep:/django/i, language:"python", framework:"django"},
  {filename:"setup.py", exists:true, language:"python", framework:null},

]

// detection rules which may be added by worker plugins
// rules must contain a property *test* which can either be a string or a function taking a callback.
// if a string, this is a shell command to be executed to run project tests (e.g. "npm install")
// if a function, this accepts a callback argument of signature function(err) which must be called.
//
// rules may contain a property *prepare* which can be a string or a function like *test*. this is for pre-test
// preparations (e.g. "npm install")
//
var detectionRules = []
// pre-start commands which may be added by worker plugins
// E.g. to start mongodb or postgresql
// pre-start commands may be either a string or a function
// XXX: foreground vs daemonprocesses
// if a string, this is a shell command to be executed to run project tests (e.g. "mongod")
// if a function, this accepts a callback argument of signature function(err) which must be called.
var setupActions = []
// teardown commands which may be added by worker plugins
// E.g. to stop mongodb or postgresql
// teardown commands may be either a string or a function
// XXX: foreground vs daemonprocesses
// if a string, this is a shell command to be executed to run project tests (e.g. "kill $PID")
// if a function, this accepts a callback argument of signature function(err) which must be called.
var teardownActions = []

function registerEvents(emitter) {


  // the queue.new_job event is primary way jobs are submitted
  //

  emitter.on('queue.new_job', function(data) {
    // cross-process (per-job) output buffers
    var stderrBuffer = ""
    var stdoutBuffer = ""
    var stdmergedBuffer = ""
    // Put stuff under `_work`
    var dir = path.join(__dirname, '_work')
    console.log('new job')
    // Start the clock
    var t1 = new Date()

    // Emit a status update event. This can result in data being sent to the
    // user's browser in realtime via socket.io.
    function updateStatus(evType, opts) {
      var t2 = new Date()
      var elapsed = (t2.getTime() - t1.getTime()) / 1000
      var msg = {
        userId:data.user_id,
        jobId:data.job_id,
        timeElapsed:elapsed,
        repoUrl:data.repo_config.url,
        stdout: opts.stdout || "",
        stderr: opts.stderr || "",
        stdmerged: opts.stdmerged || "",
        autodetectResult:opts.autodetectResult || null,
        testExitCode: null,
        deployExitCode: null,
      }
      if (opts.testExitCode !== undefined) {
        msg.testExitCode = opts.testExitCode
      }
      if (opts.deployExitCode !== undefined) {
        msg.deployExitCode = opts.deployExitCode
      }

      emitter.emit(evType, msg)
    }

    // Insert a synthetic (non job-generated) output message
    // This automatically prefixes with "[STRIDER]" to make the source
    // of the message clearer to the user.
    function striderMessage(message) {
        var msg = "[STRIDER] " + message + "\n"
        updateStatus("queue.task_update", {stdout:msg, stdmerged:msg})
    }


    function forkProc(cwd, shell) {
      var split = shell.split(/\s+/)
      var cmd = split[0]
      var args = split.slice(1)
      // Inherit parent environment
      var env = process.env
      env.PAAS_NAME = 'strider'
      var proc = spawn(cmd, args, {cwd: cwd, env: env})

      // per-process output buffers
      proc.stderrBuffer = ""
      proc.stdoutBuffer = ""
      proc.stdmergedBuffer = ""

      proc.stdout.setEncoding('utf8')
      proc.stderr.setEncoding('utf8')

      proc.stdout.on('data', function(buf) {
        proc.stdoutBuffer += buf
        proc.stdmergedBuffer += buf
        stdoutBuffer += buf
        stdmergedBuffer += buf
        updateStatus("queue.task_update" , {stdout:buf})
      })

      proc.stderr.on('data', function(buf) {
        proc.stderrBuffer += buf
        proc.stdmergedBuffer += buf
        stderrBuffer += buf
        stdmergedBuffer += buf
        updateStatus("queue.task_update", {stderr:buf})
      })

      return proc
    }

    function doTestRun(cwd, prepareCmd, testCmd) {
      var preProc = forkProc(cwd, prepareCmd)
      preProc.on('exit', function(exitCode) {
        console.log("process exited with code: %d", exitCode)
        if (exitCode === 0 && testCmd) {
          // Preparatory phase completed OK - continue
          var testProc = forkProc(cwd, testCmd)

          testProc.on('exit', function(exitCode) {
            updateStatus("queue.task_complete", {
              stderr:stderrBuffer,
              stdout:stdoutBuffer,
              stdmerged:stdmergedBuffer,
              testExitCode:exitCode,
              deployExitCode:null
            })
          })
        } else {
          updateStatus("queue.task_complete", {
            stderr:stderrBuffer,
            stdout:stdoutBuffer,
            stdmerged:stdmergedBuffer,
            testExitCode:exitCode,
            deployExitCode:null
          })

        }
      })
    }

    Step(
      function() {
        // XXX: Support incremental builds at some point
        exec('rm -rf ' + dir + ' ; mkdir -p ' + dir, this)
      },
      function(err) {
        if (err) throw err
        console.log("cloning %s", data.repo_ssh_url)
        var msg = "Starting git clone of repo at " + data.repo_ssh_url
        striderMessage(msg)
        gitane.run(dir, data.repo_config.privkey, 'git clone ' + data.repo_ssh_url, this)
      },
      function(err, stderr, stdout) {
        if (err) throw err
        this.workingDir = path.join(dir, path.basename(data.repo_ssh_url.replace('.git', '')))
        updateStatus("queue.task_update", {stdout:stdout, stderr:stderr, stdmerged:stdout+stderr})
        var msg = "Git clone complete"
        striderMessage(msg)
        gumshoe.run(this.workingDir, detectionRules, this)
      },
      function(err, result) {
        if (err) throw err
        // TODO: Setup phase (database bringup, etc)

        // Context object for action functions
        var context = {
          forkProc: forkProc,
          updateStatus: updateStatus,
          striderMessage: striderMessage,
          doTestRun: doTestRun,
          workingDir: this.workingDir,
        }
        // Execution actions may be delegated to functions.
        // This is useful for example for multi-step things like in Python where a virtual env must be set up.
        // Functions are of signature function(context, cb)
        if (typeof(result.prepare) === 'string' && typeof(result.test) === 'string') {
          doTestRun(this.workingDir, result.prepare, result.test)
          return
        }
        if (typeof(result.prepare) === 'function') {
          result.prepare(context, function(err) {
            if (typeof(result.test) === 'function') {
              result.test(context, this)
            } else {
              doTestRun(this.workingDir, result.test)
            }
          })
        } else {
          doTestRun(this.workingDir, result.prepare)
        }

        // TODO: Deploy (e.g. Heroku, dotCloud)

        // TODO: Teardown phase (database shutdown, etc)

      }

    )
  })
}

// Add an array of detection rules
function addDetectionRules(r) {
  detectionRules = detectionRules.concat(r)
}

// Add a single detection rule
function addDetectionRule(r) {
  detectionRules.push(r)

}

module.exports = function(context, cb) {
  // XXX test purposes
  detectionRules = DEFAULT_PROJECT_TYPE_RULES
  // Build a worker context, which is a stripped-down version of the webapp context
  var workerContext = {
    addDetectionRule:addDetectionRule,
    addDetectionRules:addDetectionRules,
    config: context.config,
    emitter: context.emitter,
    extdir: context.extdir,
  }

  Step(
    function() {
      context.loader.initExtensions(context.extdir, "worker", workerContext, null, this)
    },
    function(err, initialized) {
      registerEvents(context.emitter)
      console.log("Strider Simple Worker ready")
      cb(null, null)
    }
  )

}
