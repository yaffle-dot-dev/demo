#!/bin/bash
# Cleanup orphaned VPCs and all their resources
# VPCs to DELETE (orphaned):
#   vpc-07ff82356bb9ae0ff (production orphan)
#   vpc-02c7f93f01a41ec2a (nonprod orphan)
#
# VPCs to KEEP (in terraform state):
#   vpc-0d55a5f8347b264aa (production - in state)
#   vpc-097063e2b54b84664 (nonprod - in state)

set -e

ORPHAN_VPCS=("vpc-07ff82356bb9ae0ff" "vpc-02c7f93f01a41ec2a")

for VPC_ID in "${ORPHAN_VPCS[@]}"; do
  echo "=== Cleaning up orphaned VPC: $VPC_ID ==="
  
  # Delete NAT Gateways (must wait for deletion)
  echo "Deleting NAT Gateways..."
  for nat in $(aws ec2 describe-nat-gateways --filter "Name=vpc-id,Values=$VPC_ID" --query 'NatGateways[?State!=`deleted`].NatGatewayId' --output text); do
    echo "  Deleting NAT Gateway: $nat"
    aws ec2 delete-nat-gateway --nat-gateway-id "$nat"
  done
  
  # Wait for NAT gateways to delete
  echo "Waiting for NAT Gateways to delete..."
  sleep 30
  
  # Release EIPs (after NAT gateways are gone)
  echo "Releasing Elastic IPs..."
  for eip in $(aws ec2 describe-addresses --filters "Name=tag:Name,Values=yaffle-nat-eip-*" --query 'Addresses[?AssociationId==`null`].AllocationId' --output text); do
    echo "  Releasing EIP: $eip"
    aws ec2 release-address --allocation-id "$eip" 2>/dev/null || true
  done
  
  # Delete Load Balancers
  echo "Deleting Load Balancers..."
  for alb in $(aws elbv2 describe-load-balancers --query "LoadBalancers[?VpcId=='$VPC_ID'].LoadBalancerArn" --output text); do
    echo "  Deleting ALB: $alb"
    aws elbv2 delete-load-balancer --load-balancer-arn "$alb"
  done
  
  # Delete Network Interfaces
  echo "Deleting Network Interfaces..."
  for eni in $(aws ec2 describe-network-interfaces --filters "Name=vpc-id,Values=$VPC_ID" --query 'NetworkInterfaces[].NetworkInterfaceId' --output text); do
    echo "  Deleting ENI: $eni"
    aws ec2 delete-network-interface --network-interface-id "$eni" 2>/dev/null || true
  done
  
  # Delete Security Groups (except default)
  echo "Deleting Security Groups..."
  for sg in $(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" --query 'SecurityGroups[?GroupName!=`default`].GroupId' --output text); do
    echo "  Deleting SG: $sg"
    aws ec2 delete-security-group --group-id "$sg" 2>/dev/null || true
  done
  
  # Delete Subnets
  echo "Deleting Subnets..."
  for subnet in $(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --query 'Subnets[].SubnetId' --output text); do
    echo "  Deleting Subnet: $subnet"
    aws ec2 delete-subnet --subnet-id "$subnet"
  done
  
  # Delete Route Tables (except main)
  echo "Deleting Route Tables..."
  for rt in $(aws ec2 describe-route-tables --filters "Name=vpc-id,Values=$VPC_ID" --query 'RouteTables[?Associations[0].Main!=`true`].RouteTableId' --output text); do
    echo "  Deleting Route Table: $rt"
    aws ec2 delete-route-table --route-table-id "$rt"
  done
  
  # Delete Internet Gateway
  echo "Deleting Internet Gateway..."
  for igw in $(aws ec2 describe-internet-gateways --filters "Name=attachment.vpc-id,Values=$VPC_ID" --query 'InternetGateways[].InternetGatewayId' --output text); do
    echo "  Detaching and deleting IGW: $igw"
    aws ec2 detach-internet-gateway --internet-gateway-id "$igw" --vpc-id "$VPC_ID"
    aws ec2 delete-internet-gateway --internet-gateway-id "$igw"
  done
  
  # Finally delete the VPC
  echo "Deleting VPC: $VPC_ID"
  aws ec2 delete-vpc --vpc-id "$VPC_ID"
  
  echo "=== Done with $VPC_ID ==="
done

echo "Cleanup complete!"
