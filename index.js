(function() {
  'use strict';

  /* Globals */
  var AWS   = require('aws-sdk');
  var async = require('async');
  var _     = require('underscore');

  /* Config */
  var region = process.env.AWS_REGION || 'us-west-1';

  /* Objects */
  var ec2 = new AWS.EC2({region: region});

  /* Functions */
  async.waterfall([
    // Get EC2 Info
    function(callback) {
      ec2.describeInstances(callback);
    },
    // Parse Instances
    function(data, callback) {
      callback(null, _.flatten(data.Reservations.map(function(reservation) {
        return reservation.Instances;
      })));
    },
    // Populate Users for AMI
    function(instances, callback) {
      var amiCache   = [];

      async.eachSeries(instances, function(instance, callback) {
        if (amiCache[instance.ImageId]) {
          return callback();
        }

        var ami = ec2.describeImages({
          ImageIds: [
            instance.ImageId,
          ],
        }, function(err, data) {
          if (err) { return callback(err); }
          async.each(data.Images, function(image, callback) {
            var user = null;
            var name = _.values(
                         _.pick(image, 'Name', 'Description'))
                       .join(' ').toLowerCase();

            // Guess User
            if (name.includes('ubuntu')) {
              user = 'ubuntu';
            } else if (name.includes('Amazon Linux')) {
              user = 'ec2-user';
            } else {
              user = 'root';
            }

            amiCache[image.ImageId] = user;
            callback();
          }, callback);
        });
      }, function(err) {
        if (err) { return callback(err); }
        callback(null, instances, amiCache);
      });
    },
    // Build Hosts List
    function(instances, amiCache, callback) {
      callback(null, instances.map(function(instance) {
        var tags = _.object(instance.Tags.map(function(tag) {
          return [tag.Key, tag.Value];
        }));

        var config = {
          Host: tags.Name || instance.InstanceId,
          _HostName: instance.PrivateIpAddress,
          _User: amiCache[instance.ImageId],
          _IdentityFile: '~/.ssh/' + instance.KeyName + '.pem',
          _Env: tags.Env || 'EC2',
        };

        if (tags.Bastion) {
          config._ProxyCommand = 'ssh -q ' + tags.Bastion + ' nc %h 22';
        } else {
          config._Env = 'Bastion';
          config._HostName = instance.PublicIpAddress;
          config._DynamicForward = '127.0.0.1:1080';
        }

        return config;
      }));
    },
    // Filter List
    function(config, callback) {
      callback(null, config.filter(function(host) {
        return host._HostName && host._User;
      }));
    },
  ], function(err, config) {
    if (err) { console.error(err); }
    config = _.sortBy(config, 'Host');
    var hosts = _.groupBy(config, '_Env');
    console.log('### Generated SSH Config from AWS ###');
    console.log('## Hosts: ' + JSON.stringify(_.countBy(config, '_Env')));
    console.log();
    if (hosts.Bastion && hosts.Bastion.length > 0) {
      console.log('## Bastion Hosts ##\n');
      hosts.Bastion.forEach(function(host) {
        console.log('Host ' + host.Host);
        console.log('  HostName ' + host._HostName);
        console.log('  User ' + host._User);
        console.log('  DynamicForward ' + host._DynamicForward);
        console.log('  IdentityFile ' + host._IdentityFile);
        console.log();
      });
      delete(hosts.Bastion);
    }
    _.keys(hosts).sort().forEach(function(env) {
      console.log('## ' + env + ' ##\n');
      hosts[env].forEach(function(host) {
        console.log('Host ' + host.Host);
        console.log('  HostName ' + host._HostName);
        console.log('  User ' + host._User);
        console.log('  ProxyCommand ' + host._ProxyCommand);
        console.log('  IdentityFile ' + host._IdentityFile);
        console.log();
      });
    });
  });
}());
