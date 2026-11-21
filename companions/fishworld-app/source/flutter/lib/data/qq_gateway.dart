import 'qq_gateway_base.dart';
import 'qq_gateway_io.dart' if (dart.library.js) 'qq_gateway_web.dart' as impl;

export 'qq_gateway_base.dart';

QqGateway get qqGateway => impl.createQqGateway();
