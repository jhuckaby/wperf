#!/usr/bin/env node

// Simple CLI HTTP Test Script
// Requests a URL via HTTP GET continuously, up to N iterations using N threads
// Usage: wperf URL --max 1000 --threads 1 --cache_dns 0 --keepalive 0 --timeout 5 --verbose 0 --warn 1.0
// Copyright (c) 2016 - 2019 by Joseph Huckaby, MIT License

/* <Help>
Usage: wperf URL [OPTIONS...]

	--max 1000        Total number of requests to send.
	--threads 1       Number of concurrent threads to use.
	--keepalive 0     Use HTTP Keep-Alive sockets.
	--throttle 0      Limit request rate to N per sec.
	--timeout 5       Timeout for each request in seconds.
	--fatal 0         Abort on first HTTP error.
	--verbose 0       Print metrics for every request.
	--warn 1.0        Emit warnings at N seconds and longer.
	--cache_dns 0     Cache DNS for duration of run.
	--compress 1      Allow compressed responses.
	--follow          Follow HTTP 3xx redirects.
	--retries 5	      Retry errors N times.
	--auth "U:P"      HTTP Basic Auth (username:password).
	--useragent "Foo" Custom User-Agent string.
	--h_X-Test "foo"  Add any HTTP request headers.
	--method get      Specify HTTP request method.
	--f_file1 "1.txt" Attach file to HTTP POST request.
	--data "foo=bar"  Provide raw HTTP POST data.

Hit Ctrl-Z during run to see progress reports.
For more info: https://github.com/jhuckaby/wperf
</Help> */

// Capture stdin in raw mode for Ctrl-Z
var readline = require('readline');
if (process.stdin.isTTY) {
	readline.emitKeypressEvents(process.stdin);
	process.stdin.setRawMode(true);
}

var fs = require('fs');
var Path = require('path');
var querystring = require('querystring');
var package = require('./package.json');
var PixlRequest = require('pixl-request');
var cli = require('pixl-cli');
cli.global();

var Tools = cli.Tools;
var async = Tools.async;

// Process CLI args
var args = cli.args;
if (!args.other || !args.other.length || args.help) {
	fs.readFileSync( process.argv[1], 'utf8' ).match(/<Help>([\S\s]+)<\/Help>/);
	print( RegExp.$1 + "\n" );
	process.exit(0);
}
var url = args.other.shift();
var config_file = '';

// first argument may be config file
if (!url.match(/^\w+\:\/\//) && fs.existsSync(url)) {
	config_file = url;
	var config = null;
	try { config = JSON.parse( fs.readFileSync(url), 'utf8' ); }
	catch (err) {
		die("Failed to read configuration file: " + url + ": " + err + "\n");
	}
	if (!config.url) {
		die("Configuration file is missing required 'url' property: " + url + "\n");
	}
	url = args.url || config.url;
	for (var key in config) {
		if (!(key in args)) args[key] = config[key];
	}
}

if (args.params && (typeof(args.params) == 'string')) {
	// params may live in a separate file
	var params_file = args.params;
	try { args.params = JSON.parse( fs.readFileSync(params_file), 'utf8' ); }
	catch (err) {
		die("Failed to read parameters file: " + params_file + ": " + err + "\n");
	}
}

// support string "false" as boolean false in certain cases
if (args.compress === "false") args.compress = false;
if (args.color === "false") args.color = false;

var max_iter = args.max || 1;
var max_threads = args.threads || 1;
var timeout_sec = ("timeout" in args) ? args.timeout : 5.0;
var warn_sec = ("warn" in args) ? args.warn : 1.0;
var warn_ms = warn_sec * 1000;
var allow_compress = ("compress" in args) ? args.compress : 1;
var keep_alive = args.keepalive || args.keepalives || false;
var method = (args.method || 'get').toLowerCase();

// optionally disable all ANSI color
if (("color" in args) && !args.color) {
	cli.chalk.enabled = false;
}

print("\n");
print( bold.magenta("WebPerf (wperf) v" + package.version) + "\n" );
print( gray.bold("Date/Time: ") + gray((new Date()).toString() ) + "\n" );

if (config_file) {
	print( gray.bold("Configuration: ") + gray(config_file) + "\n" );
}

if (args.params) print( gray.bold("Base "));
print( gray.bold("URL: ") + gray(url + " (" + method.toUpperCase() + ")") + "\n" );

// print( gray( bold("Method: ") + method.toUpperCase()) + "\n" );
print( gray.bold("Keep-Alives: ") + gray(keep_alive ? 'Enabled' : 'Disabled') + "\n" );
print( gray.bold("Threads: ") + gray(max_threads) + "\n" );

// setup histogram system
var histo = {};

histo.cats = args.histo || ['total'];
if (histo.cats === 'all') histo.cats = ['dns', 'connect', 'send', 'wait', 'receive', 'decompress', 'total'];
if (typeof(histo.cats) == 'string') histo.cats = histo.cats.split(/\,\s*/);

histo.counts = {};
histo.cats.forEach( function(key) {
	histo.counts[key] = {};
});

histo.ranges = args.histo_ranges || [
	'0-1 ms',
	'1-2 ms',
	'2-3 ms',
	'3-4 ms',
	'4-5 ms',
	'5-10 ms',
	'10-20 ms',
	'20-30 ms',
	'30-40 ms',
	'40-50 ms',
	'50-100 ms',
	'100-200 ms',
	'200-300 ms',
	'300-400 ms',
	'400-500 ms',
	'500-1000 ms',
	'1-2 sec',
	'2-3 sec',
	'3-4 sec',
	'4-5 sec',
	'5+ sec'
];

histo.groups = histo.ranges.map( function(label) {
	var low = 0, high = 0;
	if (label.match(/(\d+)\-(\d+)\s*(\w+)$/)) {
		low = parseInt( RegExp.$1 );
		high = parseInt( RegExp.$2 );
		if (RegExp.$3 == 'sec') { low *= 1000; high *= 1000; }
	}
	else if (label.match(/^(\d+)\+\s*(\w+)$/)) {
		low = parseInt( RegExp.$1 );
		high = 86400;
		if (RegExp.$2 == 'sec') { low *= 1000; high *= 1000; }
	}
	return { low, high, label };
});

// request options
var opts = {
	timeout: timeout_sec * 1000,
	headers: args.headers || {}
};
if (args.auth) opts.auth = args.auth;
if (args.multipart) opts.multipart = true;

// Custom headers with h_ prefix, e.g. --h_Cookie "dtuid=1000000000000000001"
for (var key in args) {
	if (key.match(/^h_(.+)$/)) {
		var header_name = RegExp.$1;
		opts.headers[ header_name ] = args[key];
	}
}

// Custom file uploads with f_ prefix, e.g. f_file1 "1.txt"
if (args.files) {
	method = 'post';
	opts.multipart = true;
	opts.files = args.files;
}
for (var key in args) {
	if (key.match(/^f_(.+)$/)) {
		var param_name = RegExp.$1;
		method = 'post';
		opts.multipart = true;
		if (!opts.files) opts.files = {};
		opts.files[ param_name ] = args[key];
	}
}

// Custom raw HTTP POST data, or d_ prefix
if (args.data) {
	opts.data = args.data;
	if (!opts.headers['Content-Type'] && !opts.headers['content-type'] && (typeof(opts.data) != 'object')) {
		// convert data to hash, for application/x-www-form-urlencoded mode
		opts.data = querystring.parse(opts.data);
	}
}
for (var key in args) {
	if (key.match(/^d_(.+)$/)) {
		var param_name = RegExp.$1;
		method = 'post';
		if (!opts.data) opts.data = {};
		opts.data[ param_name ] = args[key];
	}
}

// Custom param override using p_ prefix
for (var key in args) {
	if (key.match(/^p_(.+)$/)) {
		var param_name = RegExp.$1;
		if (!args.params) args.params = {};
		args.params[ param_name ] = args[key];
	}
}

// Set User-Agent string, allow full customization
var request = new PixlRequest( args.useragent || ("Mozilla/5.0; wperf/" + package.version) );
request.setAutoError( true );

// Optionally use HTTP Keep-Alives
if (keep_alive) {
	request.setKeepAlive( true );
}

// Optionally cache DNS lookups
if (args.cache_dns) {
	request.setDNSCache( 86400 );
}

// Optionally disable compression support
if (!allow_compress) {
	request.setHeader( 'Accept-Encoding', "none" );
}

// Optionally follow redirects
if (args.follow) {
	request.setFollow( args.follow );
}

// Optionally retry errors
if (args.retries) {
	if (args.retries === true) args.retries = 1;
	request.setRetries( args.retries );
}

if (args.insecure) {
	// Allow this to work with HTTPS when the SSL certificate cannot be verified
	// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	opts.rejectUnauthorized = false;
}

// Keep track of stats
var num_warns = 0;
var count = 0;
var stats = {
	// Note: sharing namespace with pixl-request perf here
	current_sec: Tools.timeNow(true),
	count_sec: 0,
	peak_sec: 0,
	total_reqs: 0,
	total_warnings: 0,
	total_errors: 0,
	bytes_sent: 0,
	bytes_received: 0,
	time_start: Tools.timeNow()
};

print( "\n" );

// Begin progress bar
cli.progress.start({
	catchInt: true,
	catchTerm: true,
	catchCrash: false,
	exitOnSig: false
});

var floatCheckWarn = function(value) {
	// prepare float value (milliseconds) for display, using shortFloat
	// also highlight with bold + red if over the warning threshold
	var is_warning = !!(warn_ms && (value >= warn_ms));
	return is_warning ? bold.red(shortFloat(value) + ' ms') : (shortFloat(value) + ' ms');
};

var dateTimeStamp = function(epoch) {
	// return date/time stamp in [YYYY-MM-DD HH:MI:SS] format
	var dargs = Tools.getDateArgs( epoch || Tools.timeNow(true) );
	return "[" + dargs.yyyy_mm_dd + " " + dargs.hh_mi_ss + "] ";
};

var printReport = function() {
	// Show final stats in table
	if (cli.progress.running) cli.progress.erase();
	
	// general stats
	var now = Tools.timeNow();
	var elapsed = now - stats.time_start;
	var elapsed_disp = Tools.getTextFromSeconds(elapsed, false, false);
	if (elapsed < 1) elapsed_disp = Math.floor(elapsed * 1000) + " ms";
	
	if (args.verbose || num_warns) {
		print("\n");
	}
	print( bold.yellow("Total requests sent: ") + commify(stats.total_reqs) + "\n" );
	print( bold.yellow("Total time elapsed: ") + elapsed_disp + "\n" );
	print( bold.yellow("Total bytes sent: ") + Tools.getTextFromBytes(stats.bytes_sent) + " (" + Tools.getTextFromBytes(stats.bytes_sent / elapsed) + "/sec)\n" );
	print( bold.yellow("Total bytes received: ") + Tools.getTextFromBytes(stats.bytes_received) + " (" + Tools.getTextFromBytes(stats.bytes_received / elapsed) + "/sec)\n" );
	
	print( "\n" );
	print( bold.yellow("Average performance: ") + commify( Math.floor(stats.total_reqs / elapsed) ) + " req/sec\n" );
	if (stats.peak_sec && (elapsed >= 2.0)) {
		print( bold.yellow("Peak performance: ") + commify(stats.peak_sec) + " req/sec\n" );
	}
	
	print( "\n" );
	var err_color = stats.total_errors ? bold.red : bold.yellow;
	print( bold.yellow("Number of warnings: ") + commify(stats.total_warnings) + "\n" );
	print( err_color("Number of errors: ") + commify(stats.total_errors) + "\n" );
	
	var rows = [
		["Metric", "Minimum", "Average", "Maximum", "Samples"]
	];
	var labels = ['DNS', 'Connect', 'Send', 'Wait', 'Receive', 'Decompress', 'Total'];
	
	labels.forEach( function(label) {
		var key = label.toLowerCase();
		var is_total = (key == 'total');
		var color = is_total ? cyan : green;
		var stat = stats[key] || {};
		stat.avg = stat.total / (stat.count || 1);
		
		rows.push([
			color( bold( label ) ),
			color( floatCheckWarn( stat.min || 0 ) ),
			color( floatCheckWarn( stat.avg || 0 ) ),
			color( floatCheckWarn( stat.max || 0 ) ),
			color( commify( stat.count || 0 ) )
		]);
	} ); // forEach
	
	print( "\n" );
	print( bold("Performance Metrics:") + "\n" );
	print( table(rows, { textStyles: ["green"] }) + "\n" );
	
	// histograms
	labels.forEach( function(label) {
		var key = label.toLowerCase();
		if (!(key in histo.counts)) return;
		
		var counts = histo.counts[key];
		var rows = [
			["Range", "Count", "Visual"]
		];
		
		// find highest count (for visual max)
		var highest = 0;
		for (var range in counts) {
			if (counts[range] > highest) highest = counts[range];
		}
		
		histo.ranges.forEach( function(range) {
			var value = counts[range] || 0;
			var bar = "";
			var width = Math.max(0, Math.min(value / highest, 1.0)) * (args.width || 40);
			var partial = width - Math.floor(width);
			
			bar += cli.repeat(cli.progress.defaults.filled, Math.floor(width));
			if (partial > 0) {
				bar += cli.progress.defaults.filling[ Math.floor(partial * cli.progress.defaults.filling.length) ];
			}
			
			rows.push([
				range,
				Tools.commify(value),
				bar
			]);
		});
		
		print("\n");
		print( bold(label + " Time Histogram:") + "\n" );
		print( table(rows, {}) + "\n" );
	}); // histos
	
	print( "\n" );
	
	if (cli.progress.running) cli.progress.draw();
};

var nextIteration = function(err, callback) {
	// check for error, apply throttling, proceed to next iteration
	if (err) {
		stats.total_errors++;
		
		if (args.fatal) return callback(err);
		else {
			cli.progress.erase();
			if (args.verbose) print("\n");
			print( dateTimeStamp() + bold.red("ERROR: ") + err.message + "\n" );
			if (args.verbose && err.url) {
				print( dateTimeStamp() + bold.yellow("URL: ") + err.url + "\n" );
			}
			if (args.verbose && err.content) {
				print( dateTimeStamp() + bold.yellow("Content: ") + JSON.stringify(err.content) + "\n" );
			}
			if (args.verbose && err.headers) {
				print( dateTimeStamp() + bold.yellow("Headers: ") + JSON.stringify(err.headers) + "\n" );
			}
			if (args.verbose && err.perf) {
				var metrics = err.perf.metrics();
				print( dateTimeStamp() + bold.yellow("Perf: ") + JSON.stringify(metrics) + "\n" );
			}
			cli.progress.draw();
		}
	}
	
	if (args.throttle && (stats.count_sec >= args.throttle)) {
		// whoa there, slow down a bit
		var cur_sec = stats.current_sec;
		async.whilst(
			function() { return (Tools.timeNow(true) == cur_sec); },
			function(callback) { setTimeout( function() { callback(); }, 50 ); },
			callback
		);
	}
	else {
		callback();
	}
};

// Catch term, int, abort the run
var emergency_abort = false;

process.once('SIGINT', function() {
	if (cli.progress.running) cli.progress.end();
	emergency_abort = true;
	// process.stdin.end();
} );
process.once('SIGTERM', function() {
	if (cli.progress.running) cli.progress.end();
	emergency_abort = true;
	// process.stdin.end();
} );

// Capture Ctrl-Z to emit progress reports
process.stdin.on('keypress', function (ch, key) {
	if (key && key.ctrl && key.name == 'z') {
		printReport();
	}
	if (key && key.ctrl && key.name == 'c') {
		emergency_abort = true;
	}
});

// Allow CLI to provide a module that wraps the request object. 
// The module must implement METHOD(url, opts, callback) and callback with (err, resp, data, perf)
// Where METHOD is one of `get`, `post`, `head`, `put` or `delete`, depending on config.
if (args.wrapper) {
	var reqWrapper = require( args.wrapper.match(/^\//) ? args.wrapper : Path.join(process.cwd(), args.wrapper) );
	request = new reqWrapper(request, args);
}

var req_per_sec = 0;
var success_match = args.success_match ? (new RegExp(args.success_match)) : null;
var error_match = args.error_match ? (new RegExp(args.error_match)) : null;
var params = args.params || {};

for (var key in params) {
	params[key] = Tools.alwaysArray( params[key] );
}

// Main request loop
async.timesLimit( max_iter, max_threads,
	function(idx, callback) {
		var current_opts = Tools.copyHash( opts, true );
		var current_url = url;
		var ebrake = 0;
		
		// apply placeholder substitution on URL
		while (current_url.match(/\[(\w+|\d+\-\d+)\]/)) {
			current_url = current_url.replace( /\[(\d+)\-(\d+)\]/g, function(m_all, m_g1, m_g2) {
				var low = parseInt(m_g1);
				var high = parseInt(m_g2);
				return Math.round( low + ((high - low) * Math.random()) );
			});
			current_url = current_url.replace( /\[(\w+)\]/g, function(m_all, key) {
				return params[key] ? Tools.randArray(params[key]) : '';
			});
			if (++ebrake > 32) break;
		}
		
		// Allow URL to override headers for current request only
		// Example: "/ads?place=yahoo&size=160x600&chan=tst&cb=1234 [header:Cookie:dtuid=tor00355;]"
		current_url = current_url.replace(/\s*\[header\:\s*([\w\-]+)\:\s*([^\]]+)\]/ig, function(m_all, m_g1, m_g2) {
			current_opts.headers[ m_g1 ] = m_g2;
			return '';
		}).trim();
		
		// allow placeholder substitution inside header values as well
		for (var key in current_opts.headers) {
			current_opts.headers[key] = current_opts.headers[key].toString().replace( /\[(\w+)\]/g, function(m_all, key) {
				return params[key] ? Tools.randArray(params[key]) : '';
			});
		}
		
		// allow placeholder sub in post data, if raw string or hash
		if (current_opts.data) {
			if (typeof(current_opts.data) == 'string') {
				current_opts.data = current_opts.data.replace( /\[(\w+)\]/g, function(m_all, key) {
					return params[key] ? Tools.randArray(params[key]) : '';
				});
			}
			else if (Tools.isaHash(current_opts.data)) {
				for (var key in current_opts.data) {
					current_opts.data[key] = current_opts.data[key].toString().replace( /\[(\w+)\]/g, function(m_all, key) {
						return params[key] ? Tools.randArray(params[key]) : '';
					});
				}
			}
		}
		
		// send HTTP request
		request[method]( current_url, current_opts, function(err, resp, data, perf) {
			if (err) err.url = current_url;
			
			// Track req/sec
			var now_sec = Tools.timeNow(true);
			stats.count_sec++;
			stats.total_reqs++;
			
			if (now_sec != stats.current_sec) {
				stats.current_sec = now_sec;
				req_per_sec = stats.count_sec;
				if (req_per_sec > stats.peak_sec) stats.peak_sec = req_per_sec;
				stats.count_sec = 0;
			}
			
			// Update progress bar
			count++;
			cli.progress.update({ 
				amount: count / max_iter,
				text: ' [' + req_per_sec + " req/sec]"
			});
			
			if (!err && (success_match || error_match)) {
				var text = data.toString();
				if (success_match && !text.match(success_match)) {
					err = new Error("Response does not contain success match (" + args.success_match + ")");
					err.headers = resp.headers;
					err.content = text;
				}
				else if (error_match && text.match(error_match)) {
					err = new Error("Response contains error match (" + args.error_match + ")");
					err.headers = resp.headers;
					err.content = text;
				}
			}
			
			// process metrics
			var metrics = perf ? perf.metrics() : { perf: { total: 0 }, counters: {} };
			metrics.url = current_url;
			
			var is_warning = !!(warn_ms && (metrics.perf.total >= warn_ms));
			if (is_warning) {
				stats.total_warnings++;
				num_warns++;
			}
			
			if (resp && (args.verbose || is_warning)) {
				// In verbose mode, print every success and perf metrics
				cli.progress.erase();
				cli[is_warning ? 'warn' : 'verbose']( dateTimeStamp() + (is_warning ? bold.red("Perf Warning: ") : '') + 'Req #' + count + ": HTTP " + resp.statusCode + " " + resp.statusMessage + " -- " + JSON.stringify(metrics) + "\n" );
				cli.progress.draw();
			}
			
			if (resp && is_warning && args.warnings) {
				var warn_data = Tools.mergeHashes( metrics, {
					code: resp.statusCode,
					status: resp.statusMessage,
					req_num: count,
					now: now_sec,
					date_time: dateTimeStamp().trim()
				});
				fs.appendFileSync( args.warnings, JSON.stringify(warn_data) + "\n" );
			}
			
			// Compute min/avg/max stats
			for (var key in metrics.perf) {
				var value = metrics.perf[key];
				
				if (!stats[key]) stats[key] = {};
				var stat = stats[key];
				
				if (!("min" in stat) || (value < stat.min)) stat.min = value;
				if (!("max" in stat) || (value > stat.max)) stat.max = value;
				if (!("total" in stat)) stat.total = 0;
				if (!("count" in stat)) stat.count = 0;
				
				stat.total += value;
				stat.count++;
			}
			
			// Increment total counters
			for (var key in metrics.counters) {
				if (!stats[key]) stats[key] = 0;
				stats[key] += metrics.counters[key];
			}
			
			// Compute historgram data
			histo.cats.forEach( function(cat) {
				var value = metrics.perf[cat] || 0;
				var group = null;
				
				for (var idx = 0, len = histo.groups.length; idx < len; idx++) {
					group = histo.groups[idx];
					if ((value >= group.low) && (value < group.high)) {
						if (!histo.counts[cat][group.label]) histo.counts[cat][group.label] = 0;
						histo.counts[cat][group.label]++;
						idx = len;
					}
				}
			}); // histo
			
			if (emergency_abort) {
				// User hit Ctrl-C or someone TERM'ed us
				return callback( new Error("User Abort") );
			}
			else if (err) {
				// Core error such as DNS failure, socket connect timeout, custom error, etc.
				err.perf = perf;
				return nextIteration(err, callback);
			}
			else {
				// URL request was a success
				nextIteration(null, callback);
			}
		} );
	},
	function(err) {
		// All requests complete
		cli.progress.end();
		
		if (err) {
			if (args.verbose || num_warns) {
				print("\n");
			}
			print( dateTimeStamp() + bold.red("ERROR: ") + err.message + "\n" );
			if (args.verbose && err.url) {
				print( dateTimeStamp() + bold.yellow("URL: ") + err.url + "\n" );
			}
			if (args.verbose && err.content) {
				print( dateTimeStamp() + bold.yellow("Content: ") + JSON.stringify(err.content) + "\n" );
			}
			if (args.verbose && err.headers) {
				print( dateTimeStamp() + bold.yellow("Headers: ") + JSON.stringify(err.headers) + "\n" );
			}
			if (args.verbose && err.perf) {
				var metrics = err.perf.metrics();
				print( dateTimeStamp() + bold.yellow("Perf: ") + JSON.stringify(metrics) + "\n" );
			}
			print( dateTimeStamp() + "Stopped test prematurely: " + count + " of " + max_iter + " requests completed.\n" );
			num_warns++;
		}
		
		printReport();
		
		if (args.stats) {
			// emit final stats as JSON, bust through `quiet` mode too
			if (args.stats === true) process.stdout.write( JSON.stringify(stats) + "\n" );
			else fs.appendFileSync( args.stats, JSON.stringify(stats) + "\n" );
		}
		
		// process.stdin.end();
		process.exit(0);
		
	} // complete
);
