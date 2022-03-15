import { Duration, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import { Construct } from 'constructs';
import { DatabaseClusterEngine, ServerlessCluster } from 'aws-cdk-lib/aws-rds';
import { Port, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { Policy, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';

export class TestCdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // VPC関連のリソース作成
    const vpc: ec2.Vpc = new ec2.Vpc(this, 'AbeTestVpc', {
      cidr: '10.6.0.0/16',
      subnetConfiguration: [
        // Optional（省略すると、PUBLICとPRIVATE_WITH_NATのみ生成される）
        {
          cidrMask: 24,
          name: 'ingress',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'application',
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
        },
        {
          cidrMask: 28,
          name: 'rds',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // Security Group
    const ecsSG = new SecurityGroup(this, 'AbeTestEcsSecurityGroup', {
      vpc,
    });

    const rdsSG = new SecurityGroup(this, 'AbeTestRdsSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });
    // point!!
    rdsSG.connections.allowFrom(ecsSG, Port.tcp(3306), 'Ingress 3306 from ECS');

    // RDS(最低限の設定としてある)
    // Serverless Clusterを試してみた。
    const rdsCluster = new ServerlessCluster(this, 'AbeTestRds', {
      engine: DatabaseClusterEngine.AURORA_MYSQL,
      vpc,
      vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      securityGroups: [rdsSG],
      defaultDatabaseName: 'abeTest',
    });
    // const rdsCluster = new DatabaseCluster(this, 'AbeTestRds', {
    //   engine: DatabaseClusterEngine.AURORA_MYSQL,
    //   instanceProps: {
    //     vpc,
    //     vpcSubnets: {
    //       subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    //     },
    //     securityGroups: [rdsSG],
    //     instanceType: ec2.InstanceType.of(
    //       ec2.InstanceClass.BURSTABLE2,
    //       ec2.InstanceSize.SMALL
    //     ),
    //   },
    //   defaultDatabaseName: 'abeTest',
    // });

    // RDS定義の後に追加
    // SecretsManager(RDSにより自動設定)
    const secretsmanager = rdsCluster.secret!;

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'AbeTestCluster', {
      vpc: vpc,
    });

    // ALB, FargateService, TaskDefinition
    const loadBalancedFargateService =
      new ecsPatterns.ApplicationLoadBalancedFargateService(
        this,
        'AbeTestService',
        {
          cluster: cluster, // Required
          memoryLimitMiB: 512,
          cpu: 256,
          desiredCount: 1, // Optional(省略値は3)
          listenerPort: 80,
          taskImageOptions: {
            image: ecs.ContainerImage.fromRegistry(
              'akiraabe/spring-boot-docker:v0305-2'
            ),
            containerPort: 8080,
            // Secretの設定
            secrets: {
              dbname: ecs.Secret.fromSecretsManager(secretsmanager, 'dbname'),
              username: ecs.Secret.fromSecretsManager(
                secretsmanager,
                'username'
              ),
              host: ecs.Secret.fromSecretsManager(secretsmanager, 'host'),
              password: ecs.Secret.fromSecretsManager(
                secretsmanager,
                'password'
              ),
            },
          },
          securityGroups: [ecsSG],
          healthCheckGracePeriod: Duration.seconds(240),
        }
      );

    // HealthCheckの設定
    loadBalancedFargateService.targetGroup.configureHealthCheck({
      // path: '/custom-health-path',
      path: '/',
      healthyThresholdCount: 2, // Optional
      interval: Duration.seconds(15), // Optional
    });

    // 最後に追加
    // Add SecretsManager IAM policy to FargateTaskExecutionRole
    const escExecutionRole = Role.fromRoleArn(
      this,
      'ecsExecutionRole',
      loadBalancedFargateService.taskDefinition.executionRole!.roleArn,
      {}
    );
    escExecutionRole.attachInlinePolicy(
      new Policy(this, 'abeTestSMGetPolicy', {
        statements: [
          new PolicyStatement({
            actions: ['secretsmanager:GetSecretValue'],
            resources: [secretsmanager.secretArn],
          }),
        ],
      })
    );
  }
}
